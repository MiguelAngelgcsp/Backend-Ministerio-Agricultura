const router = require('express').Router();
const { pool } = require('../config/db');
const { wrap } = require('../utils/helpers');

// Catálogos no sensibles: públicos (los necesita el formulario de autoregistro y la app offline).
router.get('/entidades', wrap(async (_q, res) => res.json((await pool.query('SELECT id, sigla, nombre, tipo FROM entidad WHERE activa = 1 ORDER BY id'))[0])));
router.get('/municipios', wrap(async (_q, res) => res.json((await pool.query('SELECT codigo_dane, nombre, departamento, zona_priorizada FROM municipio ORDER BY departamento, nombre'))[0])));
router.get('/productos', wrap(async (_q, res) => res.json((await pool.query('SELECT id, codigo, nombre, categoria, unidad_medida, prioritario FROM producto ORDER BY id'))[0])));

module.exports = router;
