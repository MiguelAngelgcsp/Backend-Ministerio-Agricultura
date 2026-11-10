const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { roles, entidad, isStaff } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, idParam, paginationSchema, pageOf } = require('../utils/helpers');
const { productorIdDe, getPredio, predioCompleto } = require('../services/acceso');

const SELECT = `SELECT p.*, m.nombre AS municipio, m.departamento, m.zona_priorizada, pd.nombre_razon_social AS propietario
  FROM predio p JOIN municipio m ON m.codigo_dane = p.municipio_codigo JOIN productor pd ON pd.id = p.productor_id`;

const withCompleto = (p) => ({ ...p, completo: predioCompleto(p) });

const listQuery = paginationSchema.extend({
  productor_id: z.coerce.number().int().optional(), municipio: z.string().optional(),
  verificado: z.enum(['0', '1']).optional(), q: z.string().optional(),
});
router.get('/', validate(listQuery, 'query'), wrap(async (req, res) => {
  const q = req.query; const where = []; const params = [];
  if (!isStaff(req.user)) { where.push('p.productor_id = ?'); params.push(productorIdDe(req.user)); }
  else if (q.productor_id) { where.push('p.productor_id = ?'); params.push(q.productor_id); }
  if (q.municipio) { where.push('p.municipio_codigo = ?'); params.push(q.municipio); }
  if (q.verificado) { where.push('p.ubicacion_verificada = ?'); params.push(Number(q.verificado)); }
  if (q.q) { where.push('(p.nombre LIKE ? OR p.codigo_catastral LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(q);
  const [rows] = await pool.query(`${SELECT} ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM predio p ${w}`, params);
  res.json({ total, page: q.page, limit, data: rows.map(withCompleto) });
}));

router.get('/:id', wrap(async (req, res) => res.json(withCompleto(await getPredio(req.user, idParam(req))))));

const crearSchema = z.object({
  productor_id: z.number().int().positive().optional(),
  nombre: z.string().min(2).max(150),
  codigo_catastral: z.string().max(30).optional(),
  matricula_inmobiliaria: z.string().max(30).optional(),
  area_m2: z.number().positive(),
  latitud: z.number().min(-5).max(14),
  longitud: z.number().min(-82).max(-66),
  municipio_codigo: z.string().length(5),
});

// Política 8 / Regla 16: el predio exige propietario (productor), ubicación y área.
// Regla 15: nace con ubicación SIN verificar; debe verificarse antes de usarse (ver /verificar).
router.post('/', roles('PRODUCTOR', 'EXTENSIONISTA', 'ADMIN'), validate(crearSchema), wrap(async (req, res) => {
  const b = req.body;
  const productorId = req.user.rol === 'PRODUCTOR' ? productorIdDe(req.user) : b.productor_id;
  if (!productorId) throw new HttpError(400, 'productor_id es obligatorio (propietario del predio)');
  const [r] = await pool.query(
    `INSERT INTO predio (productor_id, nombre, codigo_catastral, matricula_inmobiliaria, area_m2, latitud, longitud, municipio_codigo)
     VALUES (?,?,?,?,?,?,?,?)`,
    [productorId, b.nombre, b.codigo_catastral ?? null, b.matricula_inmobiliaria ?? null, b.area_m2, b.latitud, b.longitud, b.municipio_codigo]);
  res.status(201).json({ id: r.insertId, ubicacion_verificada: false });
}));

const patchSchema = crearSchema.omit({ productor_id: true }).partial();
router.patch('/:id', roles('PRODUCTOR', 'EXTENSIONISTA', 'ADMIN'), validate(patchSchema), wrap(async (req, res) => {
  const p = await getPredio(req.user, idParam(req));
  const keys = Object.keys(req.body);
  if (!keys.length) throw new HttpError(400, 'Nada que actualizar');
  const sets = keys.map((k) => `${k} = ?`);
  // Si cambia la ubicación, la verificación previa deja de ser válida (Regla 15).
  if (['latitud', 'longitud', 'municipio_codigo'].some((k) => k in req.body)) {
    sets.push('ubicacion_verificada = 0', 'verificado_por = NULL', 'verificado_en = NULL');
  }
  await pool.query(`UPDATE predio SET ${sets.join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), p.id]);
  res.json({ ok: true });
}));

router.patch('/:id/verificar', roles('EXTENSIONISTA', 'ENTIDAD', 'ADMIN'), wrap(async (req, res) => {
  const [r] = await pool.query('UPDATE predio SET ubicacion_verificada = 1, verificado_por = ?, verificado_en = UTC_TIMESTAMP() WHERE id = ?', [req.user.id, idParam(req)]);
  if (!r.affectedRows) throw new HttpError(404, 'Predio no encontrado');
  res.json({ ok: true });
}));

// Regla 16: solo se asocia al Fondo de Tierras un predio con datos completos. Lo gestiona la ANT.
router.patch('/:id/fondo-tierras', entidad('ANT'), validate(z.object({ referencia: z.string().min(3).max(60) })), wrap(async (req, res) => {
  const p = await getPredio(req.user, idParam(req));
  if (!predioCompleto(p)) throw new HttpError(422, 'Regla 16: el predio debe tener propietario, ubicación verificada y área antes de asociarse al Fondo de Tierras');
  await pool.query('UPDATE predio SET referencia_fondo_tierras = ? WHERE id = ?', [req.body.referencia, p.id]);
  res.json({ ok: true });
}));

module.exports = router;
