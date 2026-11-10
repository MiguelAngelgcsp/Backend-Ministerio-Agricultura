const { pool } = require('../config/db');

const ACCION = { GET: 'CONSULTA', POST: 'CREAR', PUT: 'ACTUALIZAR', PATCH: 'ACTUALIZAR', DELETE: 'ELIMINAR' };
// Lecturas que exponen datos personales y deben quedar en bitácora (Regla 9)
const GET_AUDITADOS = /^\/api\/(productores|predios|usuarios|auditoria)/;

async function registrarAuditoria({ usuario_id = null, accion, tabla = null, registro = null, detalle = null, ip = null }) {
  try {
    await pool.query(
      'INSERT INTO auditoria (usuario_id, accion, tabla_afectada, registro_id, detalle, ip) VALUES (?,?,?,?,?,?)',
      [usuario_id, accion, tabla, registro == null ? null : String(registro), detalle ? JSON.stringify(detalle) : null, ip]
    );
  } catch (e) {
    console.error('[auditoria] no se pudo registrar:', e.message);
  }
}

/** Bitácora automática de quién consultó/modificó datos y cuándo (Política 5 / Regla 9). */
function auditMiddleware(req, res, next) {
  res.on('finish', () => {
    if (!req.user || res.statusCode >= 400) return;
    const path = req.originalUrl.split('?')[0];
    if (req.method === 'GET' && !GET_AUDITADOS.test(path)) return;
    const seg = path.replace(/^\/api\//, '').split('/');
    registrarAuditoria({
      usuario_id: req.user.id,
      accion: ACCION[req.method] || req.method,
      tabla: seg[0],
      registro: req.params?.id ?? seg[1] ?? null,
      detalle: { ruta: path, metodo: req.method, estado: res.statusCode },
      ip: req.ip,
    });
  });
  next();
}

module.exports = { auditMiddleware, registrarAuditoria };
