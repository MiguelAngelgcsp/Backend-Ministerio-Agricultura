const router = require('express').Router();
const { randomUUID } = require('crypto');
const { z } = require('zod');
const { pool, withTx } = require('../config/db');
const { roles, isStaff } = require('../middlewares/auth');
const { HttpError } = require('../utils/httpError');
const { validate, wrap, paginationSchema, pageOf, UUID_RE } = require('../utils/helpers');
const { productorIdDe, getLote } = require('../services/acceso');
const { registrarEvento, verificarCadena, eventosDeLote, TIPOS_MANUALES } = require('../services/eventos');

const SELECT = `SELECT l.id, l.codigo_trazabilidad, l.producto_id, pr.nombre AS producto, pr.categoria, l.predio_id,
       p.nombre AS predio, p.productor_id, m.nombre AS municipio, m.departamento, m.zona_priorizada,
       l.cantidad, l.unidad, l.identificador_externo, l.fecha_siembra, l.fecha_cosecha, l.estado, l.bloqueado, l.creado_en
  FROM lote l JOIN producto pr ON pr.id = l.producto_id JOIN predio p ON p.id = l.predio_id
  JOIN municipio m ON m.codigo_dane = p.municipio_codigo`;

const listQuery = paginationSchema.extend({
  producto_id: z.coerce.number().int().optional(), predio_id: z.coerce.number().int().optional(),
  estado: z.enum(['REGISTRADO', 'EN_ACOPIO', 'EN_TRANSPORTE', 'VENDIDO', 'EXPORTADO']).optional(),
  bloqueado: z.enum(['0', '1']).optional(),
});
router.get('/', validate(listQuery, 'query'), wrap(async (req, res) => {
  const q = req.query; const where = []; const params = [];
  if (!isStaff(req.user)) { where.push('p.productor_id = ?'); params.push(productorIdDe(req.user)); }
  if (q.producto_id) { where.push('l.producto_id = ?'); params.push(q.producto_id); }
  if (q.predio_id) { where.push('l.predio_id = ?'); params.push(q.predio_id); }
  if (q.estado) { where.push('l.estado = ?'); params.push(q.estado); }
  if (q.bloqueado) { where.push('l.bloqueado = ?'); params.push(Number(q.bloqueado)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = pageOf(q);
  const [rows] = await pool.query(`${SELECT} ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM lote l JOIN predio p ON p.id = l.predio_id ${w}`, params);
  res.json({ total, page: q.page, limit, data: rows });
}));

// :id acepta el id numérico o el código de trazabilidad (contenido del QR)
router.get('/:id', wrap(async (req, res) => {
  const l = await getLote(req.user, req.params.id);
  const [rows] = await pool.query(`${SELECT} WHERE l.id = ?`, [l.id]);
  res.json(rows[0]);
}));

const crearSchema = z.object({
  predio_id: z.number().int().positive(),
  producto_id: z.number().int().positive(),
  cantidad: z.number().positive(),
  unidad: z.enum(['KG', 'TON', 'CABEZAS']),
  identificador_externo: z.string().max(50).optional(),
  fecha_siembra: z.string().date().optional(),
  fecha_cosecha: z.string().date().optional(),
  // Regla 11: el código se asigna desde la finca. La app puede generarlo (UUID v4) aun sin conexión.
  codigo_trazabilidad: z.string().regex(UUID_RE, 'Debe ser un UUID').optional(),
});

// Regla 5 (trigger): predio con ubicación verificada y productor activo. Regla 11: código único.
router.post('/', roles('PRODUCTOR', 'EXTENSIONISTA', 'ADMIN'), validate(crearSchema), wrap(async (req, res) => {
  const b = req.body;
  const [[prod]] = await pool.query('SELECT categoria FROM producto WHERE id = ?', [b.producto_id]);
  if (!prod) throw new HttpError(400, 'Producto inexistente');
  if (prod.categoria === 'PECUARIO' && b.unidad !== 'CABEZAS') throw new HttpError(422, 'Los productos pecuarios se registran en CABEZAS');
  if (prod.categoria === 'AGRICOLA' && b.unidad === 'CABEZAS') throw new HttpError(422, 'Los productos agrícolas se registran en KG o TON');
  if (prod.categoria === 'PECUARIO' && !b.identificador_externo) throw new HttpError(422, 'El ganado requiere identificador_externo (arete/ID ICA)');

  const [[predio]] = await pool.query('SELECT productor_id FROM predio WHERE id = ?', [b.predio_id]);
  if (!predio) throw new HttpError(400, 'Predio inexistente');
  if (req.user.rol === 'PRODUCTOR' && predio.productor_id !== productorIdDe(req.user)) throw new HttpError(403, 'El predio no le pertenece');

  const codigo = b.codigo_trazabilidad || randomUUID();
  const [r] = await pool.query(
    `INSERT INTO lote (codigo_trazabilidad, producto_id, predio_id, cantidad, unidad, identificador_externo, fecha_siembra, fecha_cosecha, registrado_por)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [codigo, b.producto_id, b.predio_id, b.cantidad, b.unidad, b.identificador_externo ?? null, b.fecha_siembra ?? null, b.fecha_cosecha ?? null, req.user.id]);
  res.status(201).json({ id: r.insertId, codigo_trazabilidad: codigo });
}));

// ---- Cadena de custodia -------------------------------------------------------------
router.get('/:id/eventos', wrap(async (req, res) => {
  const l = await getLote(req.user, req.params.id);
  res.json(await eventosDeLote(l.id));
}));

router.get('/:id/verificar-cadena', wrap(async (req, res) => {
  const l = await getLote(req.user, req.params.id);
  res.json({ codigo_trazabilidad: l.codigo_trazabilidad, ...verificarCadena(await eventosDeLote(l.id)) });
}));

const eventoSchema = z.object({
  uuid_cliente: z.string().regex(UUID_RE).optional(),
  tipo_evento: z.enum(TIPOS_MANUALES),
  fecha_evento: z.string().datetime({ offset: true }).optional(),
  latitud: z.number().min(-5).max(14).optional(),
  longitud: z.number().min(-82).max(-66).optional(),
  detalle: z.record(z.any()).optional(),
});

// Táctica 1.1/1.2: cada escaneo/etapa queda encadenado al anterior (hash) en sp_registrar_evento.
router.post('/:id/eventos', validate(eventoSchema), wrap(async (req, res) => {
  const ref = UUID_RE.test(req.params.id) ? { lote_codigo: req.params.id } : { lote_id: Number(req.params.id) };
  const out = await withTx((conn) => registrarEvento(conn, req.user, { ...req.body, ...ref, origen: 'ONLINE' }));
  res.status(out.duplicado ? 200 : 201).json(out);
}));

module.exports = router;
