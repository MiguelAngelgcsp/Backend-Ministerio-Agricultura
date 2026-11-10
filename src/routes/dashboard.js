const router = require('express').Router();
const { pool } = require('../config/db');
const { roles } = require('../middlewares/auth');
const { wrap } = require('../utils/helpers');

// Los tableros son para quienes toman decisiones: sponsors/entidades, extensionistas y admin (Política 10).
router.use(roles('ENTIDAD', 'EXTENSIONISTA', 'ADMIN'));

// Objetivo 1.1: % de lotes trazados finca -> punto de venta por producto (meta 60 %)
router.get('/cobertura-trazabilidad', wrap(async (_q, res) => res.json((await pool.query('SELECT * FROM v_cobertura_trazabilidad'))[0])));

// Objetivo 4.1: actividad por zona priorizada
router.get('/cobertura-territorial', wrap(async (_q, res) => res.json((await pool.query('SELECT * FROM v_cobertura_territorial'))[0])));

// Regla 21/22: lotes en curso sin actualización en más de 24 h
router.get('/lotes-desactualizados', wrap(async (_q, res) => res.json((await pool.query('SELECT * FROM v_lotes_desactualizados ORDER BY horas_sin_actualizar DESC'))[0])));

// Táctica 3.2: exportaciones pendientes con checklist incompleto
router.get('/exportaciones-pendientes', wrap(async (_q, res) => res.json((await pool.query(
  "SELECT * FROM v_exportacion_completitud WHERE estado = 'PENDIENTE' ORDER BY pct_completo ASC"))[0])));

router.get('/resumen', wrap(async (_q, res) => {
  const one = async (sql) => (await pool.query(sql))[0][0];
  const [prod, pred, lotes, alertas, exp, enCurso, desact, entidadesConUsuarios, entidadesActivas] = await Promise.all([
    one('SELECT COUNT(*) total, SUM(validado) validados FROM productor'),
    one('SELECT COUNT(*) total, SUM(ubicacion_verificada) verificados FROM predio'),
    one('SELECT COUNT(*) total, SUM(bloqueado) bloqueados FROM lote'),
    one("SELECT COUNT(*) abiertas FROM alerta_sanitaria WHERE estado = 'ABIERTA'"),
    one("SELECT SUM(estado='PENDIENTE') pendientes, SUM(estado='APROBADA') aprobadas, SUM(estado='RECHAZADA') rechazadas FROM exportacion"),
    one("SELECT COUNT(*) n FROM lote WHERE estado NOT IN ('VENDIDO','EXPORTADO')"),
    one('SELECT COUNT(*) n FROM v_lotes_desactualizados'),
    one("SELECT COUNT(DISTINCT entidad_id) n FROM usuario WHERE entidad_id IS NOT NULL AND activo = 1"),
    one('SELECT COUNT(*) n FROM entidad WHERE activa = 1'),
  ]);
  const num = (v) => Number(v ?? 0);
  res.json({
    productores: { total: num(prod.total), validados: num(prod.validados) },
    predios: { total: num(pred.total), verificados: num(pred.verificados) },
    lotes: { total: num(lotes.total), bloqueados: num(lotes.bloqueados), en_curso: num(enCurso.n) },
    alertas_sanitarias_abiertas: num(alertas.abiertas),
    exportaciones: { pendientes: num(exp.pendientes), aprobadas: num(exp.aprobadas), rechazadas: num(exp.rechazadas) },
    kpis: {
      // Objetivo 1.2 (meta 70 %): trazabilidad actualizada dentro de 24 h
      pct_lotes_actualizados_24h: enCurso.n ? Math.round((1000 * (enCurso.n - desact.n)) / enCurso.n) / 10 : null,
      meta_pct_actualizados_24h: 70,
      // Objetivo 2.1 (meta 100 %): entidades adscritas ya operando en la plataforma
      pct_entidades_en_plataforma: entidadesActivas.n ? Math.round((1000 * entidadesConUsuarios.n) / entidadesActivas.n) / 10 : null,
      meta_pct_entidades: 100,
    },
  });
}));

module.exports = router;
