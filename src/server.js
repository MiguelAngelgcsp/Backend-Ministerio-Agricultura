const app = require('./app');
const { port } = require('./config/env');
const { pool } = require('./config/db');

const server = app.listen(port, () => console.log(`SIGA backend escuchando en http://localhost:${port}/api`));

const stop = async () => { server.close(); await pool.end().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
