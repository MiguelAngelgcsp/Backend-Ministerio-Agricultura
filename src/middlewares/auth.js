const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { jwt: jwtCfg } = require('../config/env');
const { HttpError } = require('../utils/httpError');

const signToken = (u) =>
  jwt.sign({ sub: u.id, rol: u.rol }, jwtCfg.secret, { expiresIn: jwtCfg.expiresIn });

/**
 * Valida el JWT y recarga al usuario desde la BD en cada petición:
 * así un cambio de rol/entidad o una desactivación surte efecto de inmediato (Regla 20).
 */
async function authenticate(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Token requerido');
    let payload;
    try { payload = jwt.verify(h.slice(7), jwtCfg.secret); }
    catch { throw new HttpError(401, 'Token inválido o expirado'); }

    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.nombre, u.rol, u.activo, u.entidad_id,
              e.sigla AS entidad_sigla, p.id AS productor_id
         FROM usuario u
         LEFT JOIN entidad e  ON e.id = u.entidad_id
         LEFT JOIN productor p ON p.usuario_id = u.id
        WHERE u.id = ?`, [payload.sub]);
    const u = rows[0];
    if (!u || !u.activo) throw new HttpError(401, 'Usuario inexistente o inactivo');
    req.user = u;
    next();
  } catch (e) { next(e); }
}

/** Permite solo los roles indicados (Política 10 / Regla 19). */
const roles = (...allowed) => (req, _res, next) =>
  allowed.includes(req.user.rol) ? next() : next(new HttpError(403, 'No tiene permisos para esta operación'));

/** ADMIN siempre; ENTIDAD solo si su sigla está en la lista (ej. DIAN, ICA, ANT). */
const entidad = (...siglas) => (req, _res, next) => {
  const u = req.user;
  if (u.rol === 'ADMIN' || (u.rol === 'ENTIDAD' && siglas.includes(u.entidad_sigla))) return next();
  next(new HttpError(403, `Operación reservada a: ${siglas.join(', ')}`));
};

const isStaff = (u) => u.rol !== 'PRODUCTOR';

module.exports = { signToken, authenticate, roles, entidad, isStaff };
