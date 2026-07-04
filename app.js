/**
 * Express Application Bootstrap
 * ──────────────────────────────────────────────────────────────
 * Security:      helmet, cors (with credentials), rate limiting
 * Auth:          cookie-parser (for httpOnly refresh tokens)
 * Error Safety:  express-async-errors (wraps all async controllers)
 * Observability: morgan colored request logs
 * Timeout:       10s global API timeout → 503 response
 */
require('express-async-errors');         // Must be before any routes/controllers

const express      = require('express');
const cors         = require('cors');
const dotenv       = require('dotenv');
const os           = require('os');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');

const routes       = require('./routes');
const errorHandler = require('./middleware/errorHandler');

dotenv.config();

const app = express();

// ── Security headers ──────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow logo/assets
}));

// ── CORS — allow frontend origin with credentials (for httpOnly cookie) ───
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,          // Required for httpOnly cookie to be sent
}));

// ── Body parsing ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());       // Parse httpOnly cookies (refreshToken)

// ── Request logger ────────────────────────────────────────────────────────
morgan.token('status-color', (_req, res) => {
  const s = res.statusCode;
  if (s >= 500) return `\x1b[31m${s}\x1b[0m`;  // red
  if (s >= 400) return `\x1b[33m${s}\x1b[0m`;  // yellow
  if (s >= 300) return `\x1b[36m${s}\x1b[0m`;  // cyan
  return `\x1b[32m${s}\x1b[0m`;                 // green
});
morgan.token('method-color', (req) => {
  const c = { GET: '\x1b[34m', POST: '\x1b[32m', PUT: '\x1b[33m', PATCH: '\x1b[35m', DELETE: '\x1b[31m' };
  return `${c[req.method] || ''}${req.method}\x1b[0m`;
});
app.use(morgan('  :method-color :url :status-color :response-time ms'));

// ── Global 10-second API timeout ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setTimeout(10_000, () => {
    res.status(503).json({ success: false, message: 'Request timed out — server is busy, please try again' });
  });
  next();
});

// ── Rate limiter ──────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again in a couple of minutes.' },
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api', limiter, routes);

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ success: true, project: 'TEAnest', status: 'running' }));

// ── 404 catch-all ─────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// ── Global error handler ──────────────────────────────────────────────────
app.use(errorHandler);

app.locals.networkInterfaces = os.networkInterfaces();
module.exports = app;
