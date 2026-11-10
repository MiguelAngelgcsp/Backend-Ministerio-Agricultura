const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool } = require('../config/db');
const { roles } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, idParam } = require('../utils/helpers');

router.use(roles('ADMIN')); // Regla 19: gestión de permisos solo para ADMIN

const ROL = z.enum(['PRODUCTOR', 'EXTENSIONISTA', 'ENTIDAD', 'ADMIN']);

router.get('/', wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.email, u.nombre, u.rol, u.activo, u.entidad_id, e.sigla AS entidad, u.creado_en
       FROM usuario u LEFT JOIN entidad e ON e.id = u.entidad_id ORDER BY u.id`);
  res.json(rows);
}));

const crearSchema = z.object({
  email: z.string().email(), password: z.string().min(8), nombre: z.string().min(2).max(150),
  rol: ROL, entidad_id: z.number().int().positive().optional(),
}).refine((d) => d.rol !== 'ENTIDAD' || d.entidad_id, { message: 'entidad_id es obligatorio para rol ENTIDAD (Política 10)', path: ['entidad_id'] });

router.post('/', validate(crearSchema), wrap(async (req, res) => {
  const b = req.body;
  const [r] = await pool.query(
    'INSERT INTO usuario (email, password_hash, nombre, rol, entidad_id) VALUES (?,?,?,?,?)',
    [b.email, await bcrypt.hash(b.password, 12), b.nombre, b.rol, b.entidad_id ?? null]);
  res.status(201).json({ id: r.insertId });
}));

// Regla 20: al cambiar rol/entidad queda en la bitácora automática y el cambio rige desde la siguiente petición.
const patchSchema = z.object({
  rol: ROL.optional(), entidad_id: z.number().int().positive().nullable().optional(), activo: z.boolean().optional(),
});
router.patch('/:id', validate(patchSchema), wrap(async (req, res) => {
  const id = idParam(req);
  const [[cur]] = await pool.query('SELECT rol, entidad_id FROM usuario WHERE id = ?', [id]);
  if (!cur) throw new HttpError(404, 'Usuario no encontrado');
  const rol = req.body.rol ?? cur.rol;
  const ent = req.body.entidad_id === undefined ? cur.entidad_id : req.body.entidad_id;
  if (rol === 'ENTIDAD' && !ent) throw new HttpError(422, 'Un usuario ENTIDAD requiere entidad_id');
  await pool.query('UPDATE usuario SET rol = ?, entidad_id = ?, activo = ? WHERE id = ?',
    [rol, ent, req.body.activo === undefined ? 1 : Number(req.body.activo), id]);
  res.json({ ok: true });
}));

module.exports = router;
