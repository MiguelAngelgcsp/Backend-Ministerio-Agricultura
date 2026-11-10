const router = require('express').Router();
const { z } = require('zod');
const { pool, withTx } = require('../config/db');
const { isStaff } = require('../middlewares/auth');
const { validate, wrap, UUID_RE } = require('../utils/helpers');
const { productorIdDe } = require('../services/acceso');
const { registrarEvento, TIPOS_MANUALES } = require('../services/eventos');

// Táctica 4.1 / Regla 24: módulo offline. La app guarda eventos localmente y los envía en lote al reconectar.
const item = z.object({
  uuid_cliente: z.string().regex(UUID_RE),
  lote_codigo: z.string().regex(UUID_RE),
  tipo_evento: z.enum(TIPOS_MANUALES),
  fecha_evento: z.string().datetime({ offset: true }),
  latitud: z.number().min(-5).max(14).optional(),
  longitud: z.number().min(-82).max(-66).optional(),
  detalle: z.record(z.any()).optional(),
});
const schema = z.object({ eventos: z.array(item).min(1).max(200) });

/**
 * Procesa cada evento en su propia transacción: uno inválido no tumba al resto.
 * Se ordenan por fecha_evento para que COSECHA llegue antes que ACOPIO aunque el dispositivo los envíe desordenados.
 * Reenvíos del mismo uuid_cliente devuelven DUPLICADO (idempotente).
 */
router.post('/eventos', validate(schema), wrap(async (req, res) => {
  const ordenados = [...req.body.eventos].sort((a, b) => new Date(a.fecha_evento) - new Date(b.fecha_evento));
  const resultados = [];
  for (const ev of ordenados) {
    try {
      const out = await withTx((conn) => registrarEvento(conn, req.user, { ...ev, origen: 'OFFLINE' }));
      resultados.push({ uuid_cliente: ev.uuid_cliente, estado: out.duplicado ? 'DUPLICADO' : 'CREADO', evento_id: out.evento.id });
    } catch (e) {
      resultados.push({ uuid_cliente: ev.uuid_cliente, estado: 'ERROR', error: e.sqlMessage || e.message, codigo: e.status || 422 });
    }
  }
  const cuenta = (s) => resultados.filter((r) => r.estado === s).length;
  res.json({ creados: cuenta('CREADO'), duplicados: cuenta('DUPLICADO'), errores: cuenta('ERROR'), resultados });
}));

// Paquete de datos para trabajar sin conexión: lotes y predios del usuario + catálogos.
router.get('/bootstrap', wrap(async (req, res) => {
  const scope = isStaff(req.user) ? '' : 'WHERE p.productor_id = ?';
  const params = isStaff(req.user) ? [] : [productorIdDe(req.user)];
  const [lotes] = await pool.query(
    `SELECT l.id, l.codigo_trazabilidad, l.producto_id, l.predio_id, l.cantidad, l.unidad, l.estado, l.bloqueado
       FROM lote l JOIN predio p ON p.id = l.predio_id ${scope} ORDER BY l.id DESC LIMIT 1000`, params);
  const [predios] = await pool.query(
    `SELECT p.id, p.nombre, p.productor_id, p.latitud, p.longitud, p.ubicacion_verificada FROM predio p ${scope} ORDER BY p.id DESC LIMIT 1000`, params);
  const [productos] = await pool.query('SELECT id, codigo, nombre, categoria, unidad_medida FROM producto');
  res.json({ generado_en: new Date().toISOString(), lotes, predios, productos, tipos_evento: TIPOS_MANUALES });
}));

module.exports = router;
