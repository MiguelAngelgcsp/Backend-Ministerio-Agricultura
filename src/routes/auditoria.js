const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { roles } = require('../middlewares/auth');
const { validate, wrap, paginationSchema, pageOf, parseJson } = require('../utils/helpers');

router.use(roles('ADMIN'));

const q = paginationSchema.extend({
  usuario_id: z.coerce.number().int().optional(), accion: z.string().optional(), tabla: z.string().optional(),
  desde: z.string().date().optional(), hasta: z.string().date().optional(),
});
router.get('/', validate(q, 'query'), wrap(async (req, res) => {
  const f = req.query; const where = []; const params = [];
  if (f.usuario_id) { where.push('usuario_id = ?'); params.push(f.usuario_id); }
  if (f.accion) { where.push('accion = ?'); params.push(f.accion); }
  if (f.tabla) { where.push('tabla_afectada = ?'); params.push(f.tabla); }
  if (f.desde) { where.push('creado_en >= ?'); params.push(`${f.desde} 00:00:00`); }
  if (f.hasta) { where.push('creado_en <= ?'); params.push(`${f.hasta} 23:59:59`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(f);
  const [rows] = await pool.query(`SELECT * FROM auditoria ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ page: f.page, limit, data: rows.map((r) => ({ ...r, detalle: parseJson(r.detalle) })) });
}));

module.exports = router;
