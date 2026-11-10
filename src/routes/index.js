const router = require('express').Router();
const { authenticate } = require('../middlewares/auth');

router.get('/health', async (_req, res) => {
  try {
    await require('../config/db').pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', hora: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degradado', db: 'sin conexión' });
  }
});

// Públicas
router.use('/auth', require('./auth'));
router.use('/catalogos', require('./catalogos'));
router.use('/public', require('./publico'));

// Protegidas (Política 10: cada ruta valida rol/alcance)
router.use(authenticate);
router.use('/usuarios', require('./usuarios'));
router.use('/productores', require('./productores'));
router.use('/predios', require('./predios'));
router.use('/lotes', require('./lotes'));
router.use('/sync', require('./sync'));
router.use('/alertas', require('./alertas'));
router.use('/exportaciones', require('./exportaciones'));
router.use('/dashboard', require('./dashboard'));
router.use('/auditoria', require('./auditoria'));

module.exports = router;
