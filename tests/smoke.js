// Prueba de integración de reglas del BMM. Requiere la BD con el esquema SIGA cargado y
// los usuarios semilla con contraseña (npm run seed-passwords). Uso: npm test
process.env.NODE_ENV = 'test';
const { randomUUID } = require('crypto');
const app = require('../src/app');
const { pool } = require('../src/config/db');

const PWD = process.env.TEST_PASSWORD || 'Siga2026*';
let base; let pass = 0; let fail = 0;

const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
};
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ✔' : '  ✘'} ${name}${cond ? '' : '  -> ' + extra}`); };
const expect = (name, res, status) => check(name, res.status === status, `esperado ${status}, recibido ${res.status} ${JSON.stringify(res.body)}`);
const login = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: PWD } })).body?.token;

(async () => {
  const server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  const admin = await login('admin@madr.gov.co');
  if (!admin) { console.error('No se pudo iniciar sesión como admin. ¿Ejecutaste npm run seed-passwords?'); process.exit(1); }
  const ica = await login('inspector@ica.gov.co');
  const ext = await login('extensionista@madr.gov.co');
  const maria = await login('maria.gomez@correo.co');

  // Usuarios DIAN y ANT (se crean si no existen)
  const tag = Date.now();
  for (const [sigla, entidad_id] of [['dian', 8], ['ant', 3]]) {
    await call('POST', '/api/usuarios', { token: admin, body: { email: `${sigla}.${tag}@gov.co`, password: 'Clave12345', nombre: sigla.toUpperCase(), rol: 'ENTIDAD', entidad_id } });
  }
  const dianTok = (await call('POST', '/api/auth/login', { body: { email: `dian.${tag}@gov.co`, password: 'Clave12345' } })).body.token;
  const antTok = (await call('POST', '/api/auth/login', { body: { email: `ant.${tag}@gov.co`, password: 'Clave12345' } })).body.token;

  console.log('\nAutenticación y acceso (Política 10 / Reglas 19-20)');
  expect('login con credenciales malas -> 401', await call('POST', '/api/auth/login', { body: { email: 'admin@madr.gov.co', password: 'x' } }), 401);
  expect('sin token -> 401', await call('GET', '/api/productores'), 401);
  const lp = await call('GET', '/api/productores', { token: maria });
  check('productor solo ve su propio registro', lp.body.total === 1 && lp.body.data[0].numero_documento === '52123456');
  expect('productor no accede a otro productor -> 404', await call('GET', '/api/productores/3', { token: maria }), 404);
  expect('productor no puede ver el dashboard -> 403', await call('GET', '/api/dashboard/resumen', { token: maria }), 403);
  expect('productor no puede ver auditoría -> 403', await call('GET', '/api/auditoria', { token: maria }), 403);
  const ent = await call('GET', '/api/productores/1', { token: ica });
  check('ENTIDAD no recibe datos de contacto (minimización)', ent.status === 200 && !('telefono' in ent.body) && !('email' in ent.body));

  console.log('\nProductores (Política 1 / Reglas 1, 7, 8)');
  const doc = String(70000000 + (tag % 9999999));
  expect('Regla 1: documento duplicado -> 409', await call('POST', '/api/productores', { token: ext, body: { tipo_documento: 'CC', numero_documento: '52123456', nombre_razon_social: 'Dup', tipo_productor: 'CAMPESINO', municipio_codigo: '17174' } }), 409);
  expect('Regla 7: comunidad étnica sin acta -> 400', await call('POST', '/api/productores', { token: ext, body: { tipo_documento: 'NIT', numero_documento: '900' + doc, nombre_razon_social: 'Comunidad X', tipo_productor: 'ETNICO', pertenece_comunidad_etnica: true, municipio_codigo: '52835' } }), 400);
  const nuevo = await call('POST', '/api/productores', { token: ext, body: { tipo_documento: 'CC', numero_documento: doc, nombre_razon_social: 'Productor Prueba', tipo_productor: 'CAMPESINO', municipio_codigo: '73268' } });
  expect('extensionista registra productor', nuevo, 201) ;
  expect('validar productor (ENTIDAD)', await call('PATCH', `/api/productores/${nuevo.body.id}/validar`, { token: ica }), 200);
  expect('extensionista no puede validar -> 403', await call('PATCH', `/api/productores/${nuevo.body.id}/validar`, { token: ext }), 403);

  console.log('\nPredios y lotes (Política 8 / Reglas 5, 11, 15, 16)');
  const predio = await call('POST', '/api/predios', { token: ext, body: { productor_id: nuevo.body.id, nombre: 'Finca Prueba', area_m2: 50000, latitud: 4.1, longitud: -74.9, municipio_codigo: '73268' } });
  expect('crear predio (nace sin verificar)', predio, 201);
  const loteBody = { predio_id: predio.body.id, producto_id: 2, cantidad: 500, unidad: 'KG' };
  expect('Regla 5/15: lote sobre predio no verificado -> 422', await call('POST', '/api/lotes', { token: ext, body: loteBody }), 422);
  expect('Regla 16: Fondo de Tierras con predio sin verificar -> 422', await call('PATCH', `/api/predios/${predio.body.id}/fondo-tierras`, { token: antTok, body: { referencia: 'FT-TEST-1' } }), 422);
  expect('verificar predio', await call('PATCH', `/api/predios/${predio.body.id}/verificar`, { token: ext }), 200);
  expect('Regla 16: Fondo de Tierras con predio completo (ANT)', await call('PATCH', `/api/predios/${predio.body.id}/fondo-tierras`, { token: antTok, body: { referencia: 'FT-TEST-1' } }), 200);
  expect('Fondo de Tierras solo ANT -> 403', await call('PATCH', `/api/predios/${predio.body.id}/fondo-tierras`, { token: ica, body: { referencia: 'X-1' } }), 403);
  expect('productor no crea lote en predio ajeno -> 403', await call('POST', '/api/lotes', { token: maria, body: { ...loteBody, predio_id: 2 } }), 403);
  expect('unidad incoherente con producto -> 422', await call('POST', '/api/lotes', { token: ext, body: { ...loteBody, unidad: 'CABEZAS' } }), 422);
  const cod = randomUUID();
  const lote = await call('POST', '/api/lotes', { token: ext, body: { ...loteBody, codigo_trazabilidad: cod } });
  check('Regla 11: lote con código de trazabilidad único', lote.status === 201 && lote.body.codigo_trazabilidad === cod, JSON.stringify(lote.body));
  expect('código de trazabilidad repetido -> 409', await call('POST', '/api/lotes', { token: ext, body: { ...loteBody, codigo_trazabilidad: cod } }), 409);
  const mlote = await call('POST', '/api/lotes', { token: maria, body: { predio_id: 1, producto_id: 2, cantidad: 100, unidad: 'KG' } });
  expect('productor crea lote en su predio', mlote, 201);

  console.log('\nCadena de custodia (Táctica 1.2 / Regla 4)');
  const L = lote.body.id;
  expect('Regla 4: VENTA sin etapas previas -> 422', await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { tipo_evento: 'VENTA' } }), 422);
  expect('Regla 4: ACOPIO sin COSECHA -> 422', await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { tipo_evento: 'ACOPIO' } }), 422);
  const evUuid = randomUUID();
  const c1 = await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { uuid_cliente: evUuid, tipo_evento: 'COSECHA', latitud: 4.1, longitud: -74.9, detalle: { nota: 'prueba' } } });
  expect('registrar COSECHA', c1, 201);
  const c1b = await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { uuid_cliente: evUuid, tipo_evento: 'COSECHA' } });
  check('reenvío del mismo uuid es idempotente', c1b.status === 200 && c1b.body.duplicado === true, JSON.stringify(c1b.body));
  expect('ACOPIO', await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { tipo_evento: 'ACOPIO' } }), 201);
  expect('TRANSPORTE', await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { tipo_evento: 'TRANSPORTE' } }), 201);
  expect('VENTA', await call('POST', `/api/lotes/${L}/eventos`, { token: ext, body: { tipo_evento: 'VENTA' } }), 201);
  const ver = await call('GET', `/api/lotes/${cod}/verificar-cadena`, { token: ext });
  check('cadena de hashes íntegra (recalculada en Node = BD)', ver.body.integra === true && ver.body.total_eventos === 4, JSON.stringify(ver.body));
  expect('ENTIDAD (no ICA) no registra eventos -> 403', await call('POST', `/api/lotes/${L}/eventos`, { token: dianTok, body: { tipo_evento: 'COSECHA' } }), 403);
  const st = await call('GET', `/api/lotes/${L}`, { token: ext });
  check('estado del lote avanzó a VENDIDO', st.body.estado === 'VENDIDO', st.body.estado);

  console.log('\nBloqueo sanitario (Regla 3 / Regla 9)');
  expect('Regla 3: VENTA de lote bloqueado (lote 4) -> 422', await call('POST', '/api/lotes/4/eventos', { token: ext, body: { tipo_evento: 'VENTA' } }), 422);
  expect('solo ICA abre alertas -> 403', await call('POST', '/api/alertas', { token: ext, body: { lote_id: 2, tipo: 'PLAGA', severidad: 'MEDIA', descripcion: 'Prueba de plaga' } }), 403);
  const al = await call('POST', '/api/alertas', { token: ica, body: { lote_id: 2, tipo: 'PLAGA', severidad: 'MEDIA', descripcion: 'Broca detectada en muestra' } });
  expect('ICA abre alerta', al, 201);
  const l2 = await call('GET', '/api/lotes/2', { token: ica });
  check('el lote quedó bloqueado automáticamente', l2.body.bloqueado === 1 || l2.body.bloqueado === true, JSON.stringify(l2.body.bloqueado));
  expect('DIAN no puede cerrar alerta del ICA -> 403', await call('PATCH', `/api/alertas/${al.body.id}/resolver`, { token: dianTok, body: { nota_resolucion: 'x x x' } }), 403);
  const rs = await call('PATCH', `/api/alertas/${al.body.id}/resolver`, { token: ica, body: { nota_resolucion: 'Lote tratado y reinspeccionado' } });
  check('ICA cierra alerta y el lote se desbloquea', rs.status === 200 && !rs.body.lote_bloqueado, JSON.stringify(rs.body));
  const ver2 = await call('GET', '/api/lotes/2/verificar-cadena', { token: ica });
  check('cadena sigue íntegra tras BLOQUEO/DESBLOQUEO', ver2.body.integra === true, JSON.stringify(ver2.body));

  console.log('\nSincronización offline (Táctica 4.1 / Regla 24)');
  const lote2 = await call('POST', '/api/lotes', { token: ext, body: { ...loteBody, cantidad: 300 } });
  const t0 = Date.now();
  const iso = (m) => new Date(t0 - m * 60000).toISOString();
  const u = [randomUUID(), randomUUID(), randomUUID()];
  const batch = [ // enviados desordenados a propósito
    { uuid_cliente: u[1], lote_codigo: lote2.body.codigo_trazabilidad, tipo_evento: 'ACOPIO', fecha_evento: iso(30) },
    { uuid_cliente: u[0], lote_codigo: lote2.body.codigo_trazabilidad, tipo_evento: 'COSECHA', fecha_evento: iso(60) },
    { uuid_cliente: u[2], lote_codigo: lote2.body.codigo_trazabilidad, tipo_evento: 'VENTA', fecha_evento: iso(5) },
  ];
  const s1 = await call('POST', '/api/sync/eventos', { token: ext, body: { eventos: batch } });
  check('lote offline desordenado: 2 creados, 1 error (VENTA sin TRANSPORTE)', s1.body.creados === 2 && s1.body.errores === 1, JSON.stringify(s1.body));
  const s2 = await call('POST', '/api/sync/eventos', { token: ext, body: { eventos: batch.slice(0, 2) } });
  check('reenvío del lote es idempotente (2 duplicados)', s2.body.duplicados === 2 && s2.body.creados === 0, JSON.stringify(s2.body));
  check('bootstrap offline entrega lotes', (await call('GET', '/api/sync/bootstrap', { token: maria })).body.lotes.length >= 1);

  console.log('\nComercio exterior (Política 12 / Regla 8)');
  const x = await call('POST', '/api/exportaciones', { token: ext, body: { lote_id: 1, pais_destino: 'Alemania' } });
  check('checklist generado con 5 ítems', x.status === 201 && x.body.checklist.length === 5, JSON.stringify(x.body));
  expect('Regla 8: aprobar con 4/5 -> 422', await call('PATCH', `/api/exportaciones/${x.body.id}/aprobar`, { token: dianTok }), 422);
  expect('solo DIAN marca documentos -> 403', await call('PATCH', `/api/exportaciones/${x.body.id}/documentos-dian`, { token: ica, body: { cumplido: true } }), 403);
  const dd = await call('PATCH', `/api/exportaciones/${x.body.id}/documentos-dian`, { token: dianTok, body: { cumplido: true } });
  check('DIAN confirma documentos', dd.status === 200 && dd.body.checklist.every((c) => c.cumplido), JSON.stringify(dd.body.checklist));
  const ap = await call('PATCH', `/api/exportaciones/${x.body.id}/aprobar`, { token: dianTok });
  check('aprobación con 5/5', ap.status === 200 && ap.body.estado === 'APROBADA', JSON.stringify(ap.body));
  const l1 = await call('GET', '/api/lotes/1', { token: ext });
  check('lote exportado (evento EXPORTACION en la cadena)', l1.body.estado === 'EXPORTADO', l1.body.estado);
  expect('exportación ya resuelta -> 409', await call('PATCH', `/api/exportaciones/${x.body.id}/rechazar`, { token: dianTok, body: { motivo_rechazo: 'tarde ya' } }), 409);
  const x4 = await call('POST', '/api/exportaciones', { token: ext, body: { lote_id: 4, pais_destino: 'Perú' } });
  await call('PATCH', `/api/exportaciones/${x4.body.id}/documentos-dian`, { token: dianTok, body: { cumplido: true } });
  expect('lote bloqueado no se puede exportar -> 422', await call('PATCH', `/api/exportaciones/${x4.body.id}/aprobar`, { token: dianTok }), 422);

  console.log('\nPúblico, tableros y auditoría (Metas 1-4 / Regla 9)');
  const pub = await call('GET', `/api/public/trazabilidad/${cod}`);
  const txt = JSON.stringify(pub.body);
  check('consulta pública por QR sin datos personales', pub.status === 200 && pub.body.linea_tiempo.length === 4 && !/Productor Prueba|numero_documento|telefono/.test(txt), txt.slice(0, 200));
  expect('código inválido -> 400', await call('GET', '/api/public/trazabilidad/abc'), 400);
  const cob = await call('GET', '/api/dashboard/cobertura-trazabilidad', { token: ica });
  check('cobertura de trazabilidad por producto', cob.status === 200 && cob.body.some((r) => r.producto === 'Arroz'), JSON.stringify(cob.body));
  expect('cobertura territorial', await call('GET', '/api/dashboard/cobertura-territorial', { token: ica }), 200);
  expect('lotes desactualizados', await call('GET', '/api/dashboard/lotes-desactualizados', { token: ica }), 200);
  const rsm = await call('GET', '/api/dashboard/resumen', { token: ica });
  check('resumen y KPIs', rsm.status === 200 && rsm.body.kpis.meta_pct_actualizados_24h === 70, JSON.stringify(rsm.body));
  await new Promise((r) => setTimeout(r, 500));
  const aud = await call('GET', '/api/auditoria?limit=100', { token: admin });
  check('bitácora registra login, creaciones y consultas', aud.status === 200 && ['LOGIN', 'CREAR', 'CONSULTA', 'LOGIN_FALLIDO'].every((a) => aud.body.data.some((r) => r.accion === a)), aud.body.data?.map((r) => r.accion).slice(0, 10).join(','));

  console.log(`\n${pass} correctas, ${fail} fallidas`);
  server.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
