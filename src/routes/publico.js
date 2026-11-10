const router = require('express').Router();
const { pool } = require('../config/db');
const { HttpError } = require('../utils/httpError');
const { wrap, UUID_RE } = require('../utils/helpers');
const { eventosDeLote, verificarCadena } = require('../services/eventos');

/**
 * Pantalla que se abre al escanear el QR (compradores, mercados). Sin autenticación.
 * Política 5/10: no expone documento, contacto ni nombre del productor; solo origen, estado y línea de tiempo.
 */
router.get('/trazabilidad/:codigo', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.codigo)) throw new HttpError(400, 'Código de trazabilidad inválido');
  const [rows] = await pool.query(
    `SELECT l.id, l.codigo_trazabilidad, pr.nombre AS producto, pr.categoria, l.cantidad, l.unidad, l.estado, l.bloqueado,
            l.fecha_cosecha, m.nombre AS municipio, m.departamento
       FROM lote l JOIN producto pr ON pr.id = l.producto_id JOIN predio p ON p.id = l.predio_id
       JOIN municipio m ON m.codigo_dane = p.municipio_codigo WHERE l.codigo_trazabilidad = ?`, [req.params.codigo]);
  const l = rows[0];
  if (!l) throw new HttpError(404, 'Lote no encontrado');
  const eventos = await eventosDeLote(l.id);
  const { id, ...lote } = l;
  res.json({
    lote: { ...lote, bloqueado: Boolean(lote.bloqueado) },
    linea_tiempo: eventos.map((e) => ({ tipo_evento: e.tipo_evento, fecha_evento: e.fecha_evento, origen: e.origen, hash_evento: e.hash_evento })),
    verificacion: verificarCadena(eventos),
  });
}));

module.exports = router;
