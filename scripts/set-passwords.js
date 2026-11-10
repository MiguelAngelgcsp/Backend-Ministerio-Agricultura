// Reemplaza los hashes de marcador de los usuarios semilla por bcrypt reales.
// Uso: npm run seed-passwords [-- <contraseña>]   (por defecto: Siga2026*)
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');

(async () => {
  const pwd = process.argv[2] || 'Siga2026*';
  const hash = await bcrypt.hash(pwd, 12);
  const [r] = await pool.query("UPDATE usuario SET password_hash = ? WHERE password_hash LIKE '%REEMPLAZAR%'", [hash]);
  console.log(`${r.affectedRows} usuarios actualizados. Contraseña demo: ${pwd}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
