const { pool } = require('../src/config/db');

(async () => {
  const [[v]] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db');
  const [ssl] = await pool.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  const [[t]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE'");
  const [[v2]] = await pool.query("SELECT COUNT(*) n FROM information_schema.views WHERE table_schema = DATABASE()");
  const [[tr]] = await pool.query('SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = DATABASE()');
  const [[sp]] = await pool.query("SELECT COUNT(*) n FROM information_schema.routines WHERE routine_schema = DATABASE()");
  console.log({ ...v, ssl_cipher: ssl[0]?.Value || '(sin SSL)', tablas: t.n, vistas: v2.n, triggers: tr.n, procedimientos: sp.n });
  console.log('Esperado: 12 tablas, 6 vistas, 12 triggers, 2 procedimientos');
  const [[u]] = await pool.query("SELECT SUM(password_hash LIKE '%REEMPLAZAR%') AS sin_hash FROM usuario");
  if (Number(u.sin_hash) > 0) console.log(`⚠ ${u.sin_hash} usuarios con hash de marcador: ejecuta  npm run seed-passwords`);
  await pool.end();
})().catch((e) => { console.error('Error de conexión:', e.code || '', e.message); process.exit(1); });
