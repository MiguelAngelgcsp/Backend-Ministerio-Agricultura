const { randomUUID } = require('crypto');
const { pool } = require('../config/db');
const { HttpError } = require('../utils/httpError');
const { UUID_RE, toMysqlUtc, parseJson, sha256 } = require('../utils/helpers');
const { getLote } = require('./acceso');

// BLOQUEO/DESBLOQUEO los generan los triggers de alerta; EXPORTACION solo al aprobar una exportación.
const TIPOS_MANUALES = ['SIEMBRA', 'COSECHA', 'ACOPIO', 'TRANSPORTE', 'VENTA', 'INSPECCION_SANITARIA'];

/**
 * Regla 4: no se registra una etapa sin la etapa anterior.
 * Se valida por PRESENCIA de eventos (no por fecha) para tolerar eventos offline que llegan desordenados.
 * SIEMBRA es opcional (el lote ya guarda fecha_siembra) y el ganado no tiene siembra/cosecha.
 */
const PREREQ = {
  AGRICOLA: { ACOPIO: ['COSECHA'], TRANSPORTE: ['COSECHA', 'ACOPIO'], VENTA: ['TRANSPORTE'] },
  PECUARIO: { VENTA: ['TRANSPORTE'] },
};

function puedeRegistrar(user, tipo, productorId) {
  if (user.rol === 'ADMIN') return true;
  if (tipo === 'INSPECCION_SANITARIA') return user.rol === 'ENTIDAD' && user.entidad_sigla === 'ICA';
  if (user.rol === 'EXTENSIONISTA') return true;
  if (user.rol === 'PRODUCTOR') return user.productor_id === productorId;
  return false;
}

const hidratar = (e) => e && { ...e, detalle: parseJson(e.detalle) };

/**
 * Registra un evento de custodia. DEBE llamarse dentro de una transacción (withTx):
 * el SELECT ... FOR UPDATE evita bifurcar la cadena de hashes si llegan dos eventos a la vez.
 * Es idempotente por uuid_cliente (sincronización offline reenviada).
 */
async function registrarEvento(conn, user, ev) {
  const tipo = ev.tipo_evento;
  if (!TIPOS_MANUALES.includes(tipo)) throw new HttpError(400, `Tipo de evento no permitido: ${tipo}`);

  const lote = await getLote(user, ev.lote_id ?? ev.lote_codigo, conn);
  if (!puedeRegistrar(user, tipo, lote.productor_id)) throw new HttpError(403, 'No tiene permiso para registrar este tipo de evento');

  const uuid = ev.uuid_cliente || randomUUID();
  if (!UUID_RE.test(uuid)) throw new HttpError(400, 'uuid_cliente debe ser un UUID');

  await conn.query('SELECT id FROM lote WHERE id = ? FOR UPDATE', [lote.id]);

  const [dup] = await conn.query('SELECT * FROM evento_custodia WHERE uuid_cliente = ?', [uuid]);
  if (dup[0]) {
    if (dup[0].lote_id !== lote.id) throw new HttpError(409, 'uuid_cliente ya fue usado en otro lote');
    return { duplicado: true, evento: hidratar(dup[0]) };
  }

  if (lote.categoria === 'PECUARIO' && ['SIEMBRA', 'COSECHA'].includes(tipo)) {
    throw new HttpError(422, `${tipo} no aplica a productos pecuarios`);
  }
  const req = PREREQ[lote.categoria]?.[tipo];
  if (req) {
    const [prev] = await conn.query(
      'SELECT 1 FROM evento_custodia WHERE lote_id = ? AND tipo_evento IN (?) LIMIT 1', [lote.id, req]);
    if (!prev.length) throw new HttpError(422, `Regla 4: ${tipo} requiere un registro previo de ${req.join(' o ')}`);
  }

  const fecha = ev.fecha_evento ? toMysqlUtc(ev.fecha_evento) : toMysqlUtc(new Date().toISOString());
  // La BD calcula la cadena de hashes y aplica la Regla 3 (lote bloqueado no se vende) vía triggers.
  await conn.query('CALL sp_registrar_evento(?,?,?,?,?,?,?,?,?)', [
    uuid, lote.id, tipo, fecha, user.id,
    ev.latitud ?? null, ev.longitud ?? null,
    ev.detalle ? JSON.stringify(ev.detalle) : null,
    ev.origen || 'ONLINE',
  ]);
  const [rows] = await conn.query('SELECT * FROM evento_custodia WHERE uuid_cliente = ?', [uuid]);
  return { duplicado: false, evento: hidratar(rows[0]) };
}

/** Recalcula la cadena de hashes (misma fórmula que sp_registrar_evento) para comprobar que no fue alterada. */
function verificarCadena(eventos) {
  let prev = null;
  const rotos = [];
  for (const e of eventos) {
    const esperado = sha256([prev ?? '', e.uuid_cliente, e.lote_id, e.tipo_evento, e.fecha_evento].join('|'));
    if ((e.hash_anterior ?? null) !== prev || e.hash_evento !== esperado) rotos.push(e.id);
    prev = e.hash_evento;
  }
  return { integra: rotos.length === 0, total_eventos: eventos.length, eventos_inconsistentes: rotos };
}

async function eventosDeLote(loteId, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM evento_custodia WHERE lote_id = ? ORDER BY id', [loteId]);
  return rows.map(hidratar);
}

/** Eventos generados por el propio sistema (p. ej. EXPORTACION al aprobar). Requiere transacción. */
async function registrarEventoSistema(conn, { lote_id, tipo_evento, usuario_id, detalle }) {
  await conn.query('SELECT id FROM lote WHERE id = ? FOR UPDATE', [lote_id]);
  await conn.query('CALL sp_registrar_evento(?,?,?,?,?,?,?,?,?)', [
    randomUUID(), lote_id, tipo_evento, toMysqlUtc(new Date().toISOString()), usuario_id, null, null,
    detalle ? JSON.stringify(detalle) : null, 'ONLINE',
  ]);
}

module.exports = { registrarEventoSistema, registrarEvento, verificarCadena, eventosDeLote, TIPOS_MANUALES, hidratar };
