const { ZodError } = require('zod');
const { HttpError } = require('../utils/httpError');
const { env } = require('../config/env');

const DUP = [
  [/uq_productor_documento/, 'Regla 1: ya existe un productor con ese tipo y número de documento'],
  [/uq_productor_usuario/, 'Ese usuario ya tiene un productor asociado'],
  [/uq_usuario_email/, 'Ya existe un usuario con ese correo'],
  [/uq_predio_catastral/, 'Ya existe un predio con ese código catastral'],
  [/uq_lote_codigo/, 'Ya existe un lote con ese código de trazabilidad'],
  [/uq_evento_uuid/, 'Evento duplicado (uuid_cliente ya registrado)'],
];

function notFound(req, _res, next) { next(new HttpError(404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`)); }

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, detalles: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Datos inválidos', detalles: err.flatten().fieldErrors });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON malformado' });

  // Errores de MySQL / reglas de negocio implementadas como triggers (SIGNAL SQLSTATE '45000')
  if (err.errno === 1062) {
    const hit = DUP.find(([re]) => re.test(err.sqlMessage || ''));
    return res.status(409).json({ error: hit ? hit[1] : 'Registro duplicado' });
  }
  if (err.sqlState === '45000') return res.status(422).json({ error: err.sqlMessage || err.message });
  if (err.errno === 1452) return res.status(400).json({ error: 'Referencia inválida: el registro relacionado no existe' });
  if (err.errno === 3819 || err.errno === 4025) return res.status(422).json({ error: `Restricción de datos incumplida: ${err.sqlMessage}` });
  if ([1264, 1265, 1366, 1292].includes(err.errno)) return res.status(400).json({ error: 'Valor inválido o fuera de rango' });

  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor', ...(env !== 'production' && { detalle: err.message }) });
}

module.exports = { notFound, errorHandler };
