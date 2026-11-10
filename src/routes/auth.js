const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool, withTx } = require('../config/db');
const { signToken, authenticate } = require('../middlewares/auth');
const { registrarAuditoria } = require('../middlewares/audit');
const { HttpError } = require('../utils/httpError');
const { validate, wrap } = require('../utils/helpers');
const { productorBase, consultaPrevia, insertarProductor } = require('./productores');

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post('/login', validate(loginSchema), wrap(async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT id, email, nombre, rol, password_hash, activo, entidad_id FROM usuario WHERE email = ?', [email]);
  const u = rows[0];
  const ok = u && u.activo && (await bcrypt.compare(password, u.password_hash).catch(() => false));
  if (!ok) {
    await registrarAuditoria({ usuario_id: u?.id ?? null, accion: 'LOGIN_FALLIDO', tabla: 'usuario', detalle: { email }, ip: req.ip });
    throw new HttpError(401, 'Credenciales inválidas');
  }
  await registrarAuditoria({ usuario_id: u.id, accion: 'LOGIN', tabla: 'usuario', registro: u.id, ip: req.ip });
  res.json({
    token: signToken(u),
    usuario: { id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, entidad_id: u.entidad_id },
  });
}));

// Autoregistro de productor: crea usuario + productor en una transacción (Política 1 / Regla 1).
const registerSchema = consultaPrevia(productorBase.extend({
  email: z.string().email(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  consentimiento_datos: z.literal(true, { errorMap: () => ({ message: 'Debe autorizar el tratamiento de datos personales (Ley 1581)' }) }),
}));

router.post('/register', validate(registerSchema), wrap(async (req, res) => {
  const b = req.body;
  const hash = await bcrypt.hash(b.password, 12);
  const out = await withTx(async (conn) => {
    const [u] = await conn.query(
      "INSERT INTO usuario (email, password_hash, nombre, rol) VALUES (?,?,?, 'PRODUCTOR')",
      [b.email, hash, b.nombre_razon_social]);
    const productorId = await insertarProductor(conn, { ...b, usuario_id: u.insertId, registrado_por: u.insertId });
    return { usuario_id: u.insertId, productor_id: productorId };
  });
  res.status(201).json({ ...out, mensaje: 'Registro creado. Queda pendiente de validación por una entidad.' });
}));

router.get('/me', authenticate, (req, res) => res.json(req.user));

router.post('/cambiar-password', authenticate, validate(z.object({
  actual: z.string(), nueva: z.string().min(8),
})), wrap(async (req, res) => {
  const [[u]] = await pool.query('SELECT password_hash FROM usuario WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(req.body.actual, u.password_hash).catch(() => false))) throw new HttpError(401, 'Contraseña actual incorrecta');
  await pool.query('UPDATE usuario SET password_hash = ? WHERE id = ?', [await bcrypt.hash(req.body.nueva, 12), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
