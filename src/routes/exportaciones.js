const router = require('express').Router();
const { z } = require('zod');
const { pool, withTx } = require('../config/db');
const { roles, entidad, isStaff } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, idParam, paginationSchema, pageOf } = require('../utils/helpers');
const { productorIdDe, getLote } = require('../services/acceso');
const { registrarEventoSistema } = require('../services/eventos');

async function cargar(user, id, conn = pool) {
  const [rows] = await conn.query(
    `SELECT x.*, l.codigo_trazabilidad, p.productor_id
       FROM exportacion x JOIN lote l ON l.id = x.lote_id JOIN predio p ON p.id = l.predio_id
      WHERE x.id = ?`, [id]);
  const x = rows[0];
  if (!x || (user.rol === 'PRODUCTOR' && x.productor_id !== user.productor_id)) throw new HttpError(404, 'Exportación no encontrada');
  const [checklist] = await conn.query('SELECT item, cumplido, verificado_en FROM exportacion_checklist WHERE exportacion_id = ? ORDER BY id', [id]);
  return { ...x, checklist: checklist.map((c) => ({ ...c, cumplido: Boolean(c.cumplido) })) };
}

const listQuery = paginationSchema.extend({ estado: z.enum(['PENDIENTE', 'APROBADA', 'RECHAZADA']).optional() });
router.get('/', validate(listQuery, 'query'), wrap(async (req, res) => {
  const q = req.query; const where = []; const params = [];
  if (!isStaff(req.user)) { where.push('p.productor_id = ?'); params.push(productorIdDe(req.user)); }
  if (q.estado) { where.push('v.estado = ?'); params.push(q.estado); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(q);
  const [rows] = await pool.query(
    `SELECT v.* FROM v_exportacion_completitud v
       JOIN exportacion x ON x.id = v.exportacion_id JOIN lote l ON l.id = x.lote_id JOIN predio p ON p.id = l.predio_id
       ${w} ORDER BY v.exportacion_id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ page: q.page, limit, data: rows });
}));

router.get('/:id', wrap(async (req, res) => res.json(await cargar(req.user, idParam(req)))));

// Regla 8: al crear la solicitud, el trigger genera el checklist con datos reales.
router.post('/', roles('PRODUCTOR', 'EXTENSIONISTA', 'ADMIN'),
  validate(z.object({ lote_id: z.number().int().positive(), pais_destino: z.string().min(2).max(60) })),
  wrap(async (req, res) => {
    await getLote(req.user, req.body.lote_id);
    const [r] = await pool.query('INSERT INTO exportacion (lote_id, pais_destino, solicitada_por) VALUES (?,?,?)',
      [req.body.lote_id, req.body.pais_destino, req.user.id]);
    res.status(201).json(await cargar(req.user, r.insertId));
  }));

router.post('/:id/recalcular', wrap(async (req, res) => {
  const x = await cargar(req.user, idParam(req));
  if (x.estado !== 'PENDIENTE') throw new HttpError(409, 'La exportación ya fue resuelta');
  await pool.query('CALL sp_recalcular_checklist(?,?)', [x.id, x.lote_id]);
  res.json(await cargar(req.user, x.id));
}));

// DOCUMENTOS_DIAN es manual: lo confirma la DIAN (Táctica 3.1) tras contrastar la declaración.
router.patch('/:id/documentos-dian', entidad('DIAN'), validate(z.object({ cumplido: z.boolean() })), wrap(async (req, res) => {
  const x = await cargar(req.user, idParam(req));
  if (x.estado !== 'PENDIENTE') throw new HttpError(409, 'La exportación ya fue resuelta');
  await pool.query(
    "UPDATE exportacion_checklist SET cumplido = ?, verificado_en = UTC_TIMESTAMP() WHERE exportacion_id = ? AND item = 'DOCUMENTOS_DIAN'",
    [Number(req.body.cumplido), x.id]);
  res.json(await cargar(req.user, x.id));
}));

/**
 * Política 12 / Regla 8: recalcula el checklist y solo aprueba con 5/5 (lo exige el trigger trg_exportacion_bu).
 * Al aprobar se registra el evento EXPORTACION en la cadena de custodia (lote -> EXPORTADO).
 */
router.patch('/:id/aprobar', entidad('DIAN', 'MADR'), wrap(async (req, res) => {
  const id = idParam(req);
  await withTx(async (conn) => {
    const [[x]] = await conn.query('SELECT lote_id, estado, pais_destino FROM exportacion WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw new HttpError(404, 'Exportación no encontrada');
    if (x.estado !== 'PENDIENTE') throw new HttpError(409, 'La exportación ya fue resuelta');
    await conn.query('CALL sp_recalcular_checklist(?,?)', [id, x.lote_id]);
    await conn.query("UPDATE exportacion SET estado = 'APROBADA', resuelta_por = ?, resuelta_en = UTC_TIMESTAMP() WHERE id = ?", [req.user.id, id]);
    // Evento EXPORTACION emitido por el sistema; si el lote está bloqueado, el trigger trg_evento_bi lo rechaza (Regla 3).
    await registrarEventoSistema(conn, {
      lote_id: x.lote_id, tipo_evento: 'EXPORTACION', usuario_id: req.user.id,
      detalle: { exportacion_id: id, pais_destino: x.pais_destino },
    });
  });
  res.json(await cargar(req.user, id));
}));

router.patch('/:id/rechazar', entidad('DIAN', 'MADR'), validate(z.object({ motivo_rechazo: z.string().min(5).max(300) })), wrap(async (req, res) => {
  const id = idParam(req);
  const [r] = await pool.query(
    "UPDATE exportacion SET estado = 'RECHAZADA', resuelta_por = ?, resuelta_en = UTC_TIMESTAMP(), motivo_rechazo = ? WHERE id = ? AND estado = 'PENDIENTE'",
    [req.user.id, req.body.motivo_rechazo, id]);
  if (!r.affectedRows) throw new HttpError(409, 'La exportación no existe o ya fue resuelta');
  res.json(await cargar(req.user, id));
}));

module.exports = router;
