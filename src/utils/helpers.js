const crypto = require('crypto');
const { z } = require('zod');
const { HttpError } = require('./httpError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ISO 8601 con zona -> 'YYYY-MM-DD HH:MM:SS' en UTC. */
const toMysqlUtc = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Fecha inválida');
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Middleware de validación con zod. */
const validate = (schema, where = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return next(new HttpError(400, 'Datos inválidos', r.error.flatten().fieldErrors));
  req[where] = r.data;
  next();
};

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const pageOf = (q) => ({ limit: q.limit, offset: (q.page - 1) * q.limit });

const idParam = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Id inválido');
  return n;
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { UUID_RE, toMysqlUtc, parseJson, sha256, validate, paginationSchema, pageOf, idParam, wrap };
