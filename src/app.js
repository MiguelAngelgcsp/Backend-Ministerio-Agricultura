const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { corsOrigin, env } = require('./config/env');
const { auditMiddleware } = require('./middlewares/audit');
const { notFound, errorHandler } = require('./middlewares/error');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));
if (env !== 'test') app.use(morgan('dev'));

app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

app.use(auditMiddleware);
app.use('/api', require('./routes'));
app.use(notFound);
app.use(errorHandler);

module.exports = app;
