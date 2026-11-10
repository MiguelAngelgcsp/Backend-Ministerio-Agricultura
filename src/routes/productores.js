const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { roles, entidad, isStaff } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, idParam, paginationSchema, pageOf } = require('../utils/helpers');
const { productorIdDe } = require('../services/acceso');

const bool = z.boolean().default(false);

const base = z.object({
  tipo_documento: z.enum(['CC', 'CE', 'NIT']),
  numero_documento: z.string().min(5).max(20),
  nombre_razon_social: z.string().min(2).max(200),
  tipo_productor: z.enum(['CAMPESINO', 'ETNICO', 'EMPRESARIAL']),
  telefono: z.string().max(20).optional(),
  email: z.string().email().max(150).optional(),
  municipio_codigo: z.string().length(5),
  pertenece_comunidad_etnica: bool,
  consentimiento_datos: bool,
  consentimiento_fecha: z.string().date().optional(),
  consentimiento_acta: z.string().max(100).optional(),
});

/**
 * Política 4 / Reglas 7-8: una comunidad étnica solo se registra con acta/autorización
 * (indicando acta y fecha de otorgamiento). Sin ella el registro queda bloqueado (se rechaza).
 */
const consulta = (schema) => schema.superRefine((d, ctx) => {
  if (d.pertenece_comunidad_etnica || d.tipo_productor === 'ETNICO') {
    if (!d.consentimiento_datos) ctx.addIssue({ code: 'custom', path: ['consentimiento_datos'], message: 'Regla 7: se requiere consulta previa/autorización firmada' });
    if (!d.consentimiento_acta) ctx.addIssue({ code: 'custom', path: ['consentimiento_acta'], message: 'Regla 8: indique el acta de autorización' });
    if (!d.consentimiento_fecha) ctx.addIssue({ code: 'custom', path: ['consentimiento_fecha'], message: 'Regla 8: indique la fecha en que se otorgó' });
  }
});
const productorSchema = consulta(base);

/** INSERT compartido por el registro por extensionista y el autoregistro. Regla 1 la garantiza uq_productor_documento. */
async function insertarProductor(conn, b) {
  const [r] = await conn.query(
    `INSERT INTO productor (usuario_id, tipo_documento, numero_documento, nombre_razon_social, tipo_productor,
        telefono, email, municipio_codigo, pertenece_comunidad_etnica, consentimiento_datos,
        consentimiento_fecha, consentimiento_acta, registrado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.usuario_id ?? null, b.tipo_documento, b.numero_documento, b.nombre_razon_social, b.tipo_productor,
     b.telefono ?? null, b.email ?? null, b.municipio_codigo, Number(b.pertenece_comunidad_etnica),
     Number(b.consentimiento_datos), b.consentimiento_fecha ?? null, b.consentimiento_acta ?? null, b.registrado_por ?? null]);
  return r.insertId;
}

/** Política 10: la entidad solo ve lo necesario -> se ocultan datos de contacto para ENTIDAD. */
const minimizar = (user, p) => {
  if (user.rol === 'ENTIDAD' && p) { const { telefono, email, ...rest } = p; return rest; }
  return p;
};

const SELECT = `SELECT p.id, p.usuario_id, p.tipo_documento, p.numero_documento, p.nombre_razon_social, p.tipo_productor,
       p.telefono, p.email, p.municipio_codigo, m.nombre AS municipio, m.departamento, m.zona_priorizada,
       p.estado, p.validado, p.validado_por, p.validado_en, p.pertenece_comunidad_etnica,
       p.consentimiento_datos, p.consentimiento_fecha, p.consentimiento_acta, p.registrado_por, p.creado_en, p.actualizado_en
  FROM productor p JOIN municipio m ON m.codigo_dane = p.municipio_codigo`;

const listQuery = paginationSchema.extend({
  q: z.string().optional(), estado: z.enum(['ACTIVO', 'INACTIVO', 'SUSPENDIDO']).optional(),
  validado: z.enum(['0', '1']).optional(), municipio: z.string().optional(), tipo_productor: z.enum(['CAMPESINO', 'ETNICO', 'EMPRESARIAL']).optional(),
});

router.get('/', validate(listQuery, 'query'), wrap(async (req, res) => {
  const q = req.query; const where = []; const params = [];
  if (!isStaff(req.user)) { where.push('p.id = ?'); params.push(productorIdDe(req.user)); }
  if (q.q) { where.push('(p.nombre_razon_social LIKE ? OR p.numero_documento LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.estado) { where.push('p.estado = ?'); params.push(q.estado); }
  if (q.validado) { where.push('p.validado = ?'); params.push(Number(q.validado)); }
  if (q.municipio) { where.push('p.municipio_codigo = ?'); params.push(q.municipio); }
  if (q.tipo_productor) { where.push('p.tipo_productor = ?'); params.push(q.tipo_productor); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(q);
  const [rows] = await pool.query(`${SELECT} ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM productor p ${w}`, params);
  res.json({ total, page: q.page, limit, data: rows.map((r) => minimizar(req.user, r)) });
}));

async function cargar(req) {
  const id = idParam(req);
  if (!isStaff(req.user) && id !== productorIdDe(req.user)) throw new HttpError(404, 'Productor no encontrado');
  const [rows] = await pool.query(`${SELECT} WHERE p.id = ?`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Productor no encontrado');
  return rows[0];
}

router.get('/:id', wrap(async (req, res) => res.json(minimizar(req.user, await cargar(req)))));

// Regla 2: trámites se asocian al documento -> endpoint de consulta por cédula/NIT para las entidades adscritas.
router.get('/documento/:tipo/:numero', roles('EXTENSIONISTA', 'ENTIDAD', 'ADMIN'), wrap(async (req, res) => {
  const [rows] = await pool.query(`${SELECT} WHERE p.tipo_documento = ? AND p.numero_documento = ?`, [req.params.tipo, req.params.numero]);
  if (!rows[0]) throw new HttpError(404, 'Productor no encontrado');
  res.json(minimizar(req.user, rows[0]));
}));

// Registro asistido por extensionista (Regla 1: documento duplicado -> 409).
router.post('/', roles('EXTENSIONISTA', 'ADMIN'), validate(productorSchema), wrap(async (req, res) => {
  const id = await insertarProductor(pool, { ...req.body, registrado_por: req.user.id });
  res.status(201).json({ id });
}));

const patchSchema = z.object({
  nombre_razon_social: z.string().min(2).max(200).optional(),
  telefono: z.string().max(20).nullable().optional(),
  email: z.string().email().max(150).nullable().optional(),
  municipio_codigo: z.string().length(5).optional(),
});
router.patch('/:id', validate(patchSchema), wrap(async (req, res) => {
  const id = idParam(req);
  if (req.user.rol === 'ENTIDAD') throw new HttpError(403, 'No tiene permisos para modificar productores');
  if (req.user.rol === 'PRODUCTOR' && id !== productorIdDe(req.user)) throw new HttpError(404, 'Productor no encontrado');
  const sets = Object.keys(req.body);
  if (!sets.length) throw new HttpError(400, 'Nada que actualizar');
  const [r] = await pool.query(`UPDATE productor SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => req.body[k]), id]);
  if (!r.affectedRows) throw new HttpError(404, 'Productor no encontrado');
  res.json({ ok: true });
}));

router.patch('/:id/validar', roles('ENTIDAD', 'ADMIN'), wrap(async (req, res) => {
  const [r] = await pool.query('UPDATE productor SET validado = 1, validado_por = ?, validado_en = UTC_TIMESTAMP() WHERE id = ?', [req.user.id, idParam(req)]);
  if (!r.affectedRows) throw new HttpError(404, 'Productor no encontrado');
  res.json({ ok: true });
}));

router.patch('/:id/estado', roles('ENTIDAD', 'ADMIN'), validate(z.object({ estado: z.enum(['ACTIVO', 'INACTIVO', 'SUSPENDIDO']) })), wrap(async (req, res) => {
  const [r] = await pool.query('UPDATE productor SET estado = ? WHERE id = ?', [req.body.estado, idParam(req)]);
  if (!r.affectedRows) throw new HttpError(404, 'Productor no encontrado');
  res.json({ ok: true });
}));

module.exports = router;
module.exports.productorSchema = productorSchema;
module.exports.productorBase = base;
module.exports.consultaPrevia = consulta;
module.exports.insertarProductor = insertarProductor;
