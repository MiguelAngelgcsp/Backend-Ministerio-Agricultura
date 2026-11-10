const fs = require('fs');
const mysql = require('mysql2/promise');
const { db } = require('./env');

// Regla 9 (Política 5): toda transmisión de datos personales va cifrada -> TLS hacia la BD.
let ssl;
if (db.ssl) {
  ssl = db.sslCa
    ? { ca: fs.readFileSync(db.sslCa), rejectUnauthorized: true }
    : { rejectUnauthorized: false }; // equivale a ssl-mode=REQUIRED de Aiven
}

const pool = mysql.createPool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  ssl,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,      // DATETIME como 'YYYY-MM-DD HH:MM:SS' (necesario para recalcular los hashes)
  timezone: 'Z',          // todo se maneja en UTC
  decimalNumbers: true,
  charset: 'utf8mb4',
});

/** Ejecuta fn(conn) dentro de una transacción. Rollback ante cualquier error (incluye SIGNAL de triggers). */
async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* noop */ }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTx };
