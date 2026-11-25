const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initDb, pingDb, closeDb } = require('./src/db');
const { router: apiRouter, tick } = require('./src/api');
const { errorHandler } = require('./src/errors');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Origin tidak diizinkan oleh CORS'));
  },
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '3.5mb' }));

app.get('/health', async (req, res) => {
  try {
    await pingDb();
    res.json({ status: 'ok', db: 'connected', uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/api', apiRouter);

app.use(express.static(PUBLIC, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.sendFile(path.join(PUBLIC, 'index.html'));
  }
  return res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan' },
  });
});

app.use(errorHandler);

let tickTimer = null;
let activeServer = null;

async function start() {
  await initDb();
  tickTimer = setInterval(tick, 2000);
  return new Promise(resolve => {
    activeServer = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Campus Eats berjalan di http://0.0.0.0:${PORT}`);
      resolve(activeServer);
    });
  });
}

async function shutdown() {
  if (tickTimer) clearInterval(tickTimer);
  if (activeServer) {
    await new Promise(resolve => activeServer.close(resolve));
  }
  await closeDb();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  start().catch(err => {
    console.error('Gagal menjalankan server:', err);
    process.exit(1);
  });
}

module.exports = { app, start, initDb, closeDb, stopTick: () => clearInterval(tickTimer) };
