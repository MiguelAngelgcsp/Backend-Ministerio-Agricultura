const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { roles, entidad, isStaff } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, idParam, paginationSchema, pageOf } = require('../utils/helpers');
const { productorIdDe, getLote } = require('../services/acceso');

const SELECT = `SELECT a.*, l.codigo_trazabilidad, pr.nombre AS producto, e.sigla AS entidad
  FROM alerta_sanitaria a JOIN lote l ON l.id = a.lote_id JOIN producto pr ON pr.id = l.producto_id
  JOIN entidad e ON e.id = a.entidad_id JOIN predio p ON p.id = l.predio_id`;

const listQuery = paginationSchema.extend({
  estado: z.enum(['ABIERTA', 'RESUELTA']).optional(), lote_id: z.coerce.number().int().optional(),
  severidad: z.enum(['BAJA', 'MEDIA', 'ALTA']).optional(),
});
router.get('/', validate(listQuery, 'query'), wrap(async (req, res) => {
  const q = req.query; const where = []; const params = [];
  if (!isStaff(req.user)) { where.push('p.productor_id = ?'); params.push(productorIdDe(req.user)); }
  if (q.estado) { where.push('a.estado = ?'); params.push(q.estado); }
  if (q.lote_id) { where.push('a.lote_id = ?'); params.push(q.lote_id); }
  if (q.severidad) { where.push('a.severidad = ?'); params.push(q.severidad); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(q);
  const [rows] = await pool.query(`${SELECT} ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ page: q.page, limit, data: rows });
}));

const crearSchema = z.object({
  lote_id: z.number().int().positive(),
  tipo: z.enum(['PLAGA', 'ENFERMEDAD', 'CONTAMINACION', 'OTRO']),
  severidad: z.enum(['BAJA', 'MEDIA', 'ALTA']),
  descripcion: z.string().min(5).max(500),
});

/**
 * Regla 3: la abre el ICA. El trigger trg_alerta_ai bloquea el lote y deja el evento BLOQUEO en la cadena,
 * y trg_lote_bu / trg_evento_bi impiden VENTA/EXPORTACION mientras siga bloqueado.
 */
router.post('/', entidad('ICA'), validate(crearSchema), wrap(async (req, res) => {
  const b = req.body;
  await getLote(req.user, b.lote_id); // 404 si no existe
  const [r] = await pool.query(
    'INSERT INTO alerta_sanitaria (lote_id, entidad_id, reportada_por, tipo, severidad, descripcion) VALUES (?,?,?,?,?,?)',
    [b.lote_id, req.user.entidad_id, req.user.id, b.tipo, b.severidad, b.descripcion]);
  res.status(201).json({ id: r.insertId, lote_bloqueado: true });
}));

// Regla 9 (trigger): solo un funcionario autorizado cierra la alerta. Si no quedan abiertas, el lote se desbloquea.
router.patch('/:id/resolver', roles('ENTIDAD', 'ADMIN'), validate(z.object({ nota_resolucion: z.string().min(3).max(500) })), wrap(async (req, res) => {
  const id = idParam(req);
  const [[a]] = await pool.query('SELECT entidad_id, estado, lote_id FROM alerta_sanitaria WHERE id = ?', [id]);
  if (!a) throw new HttpError(404, 'Alerta no encontrada');
  if (a.estado === 'RESUELTA') throw new HttpError(409, 'La alerta ya fue resuelta');
  if (req.user.rol === 'ENTIDAD' && req.user.entidad_id !== a.entidad_id) throw new HttpError(403, 'Solo la entidad que abrió la alerta puede cerrarla');
  await pool.query(
    "UPDATE alerta_sanitaria SET estado = 'RESUELTA', resuelta_en = UTC_TIMESTAMP(), resuelta_por = ?, nota_resolucion = ? WHERE id = ?",
    [req.user.id, req.body.nota_resolucion, id]);
  const [[l]] = await pool.query('SELECT bloqueado FROM lote WHERE id = ?', [a.lote_id]);
  res.json({ ok: true, lote_bloqueado: Boolean(l.bloqueado) });
}));

module.exports = router;
