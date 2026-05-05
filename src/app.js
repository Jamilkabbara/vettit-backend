require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const missionRoutes = require('./routes/missions');
const aiRoutes = require('./routes/ai');
const paymentRoutes = require('./routes/payments');
const resultsRoutes = require('./routes/results');
const uploadsRoutes = require('./routes/uploads');
const profileRoutes = require('./routes/profile');
const webhookRoutes = require('./routes/webhooks');
// Pass 23 A9 — notificationRoutes removed. Frontend reads + writes
// notifications directly via supabase.from('notifications') with the
// users_own_notif RLS policy (Pass 23 A2/Bug 23.11). The 4 endpoints
// in routes/notifications.js were dead code post-A2.
const adminRoutes = require('./routes/admin');
const adminCostsRoutes = require('./routes/adminCosts');
const blogRoutes = require('./routes/blog');
const chatRoutes = require('./routes/chat');
const pricingRoutes = require('./routes/pricing');
const crmRoutes = require('./routes/crm');
const funnelRoutes = require('./routes/funnel');

const app = express();

// ─── Security ───────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────
// Accepts:
//  - Production: https://vettit.ai, https://www.vettit.ai
//  - Local dev: http://localhost:{5173,3000}
//  - Vercel previews: https://vett-platform-*-jamil-kabbaras-projects.vercel.app
//  - FRONTEND_URL env override (optional escape hatch)
const VERCEL_PREVIEW_RE = /^https:\/\/vett-platform-.*-jamil-kabbaras-projects\.vercel\.app$/;
const STATIC_ORIGINS = [
  'https://vettit.ai',
  'https://www.vettit.ai',
  'http://localhost:5173',
  'http://localhost:3000',
];
if (process.env.FRONTEND_URL) STATIC_ORIGINS.push(process.env.FRONTEND_URL);

app.use(cors({
  origin: (origin, cb) => {
    // Non-browser or same-origin requests have no Origin header — always allow.
    if (!origin) return cb(null, true);
    if (STATIC_ORIGINS.includes(origin)) return cb(null, true);
    if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ─── Webhooks need raw body — mount BEFORE json parser ───────
app.use('/api/webhooks', webhookRoutes);

// ─── Body Parsing ────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Pass 27 J — Cache-Control hygiene. Static-ish reference data caches
// for 5 min at the browser + 10 min at the edge; user data never
// caches. Skipped for non-GET (no body-changing route should cache).
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/version') || req.path.startsWith('/healthz')) {
    res.set('Cache-Control', 'public, max-age=60');
  } else if (req.path.startsWith('/api/admin/')) {
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
  } else if (req.path.startsWith('/api/')) {
    // User-specific by default — never cache by default.
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
  }
  next();
});

// ─── Logging ─────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ─── Rate Limiting ───────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests. Please try again later.' }
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'AI rate limit reached. Please wait a moment.' }
});
// Chat allows a higher burst — quota enforcement happens inside the service
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Chat rate limit reached. Please wait a moment.' }
});
// Pass 22 Bug 22.1 — funnel ingestion is anon-friendly tracking; legitimate
// sessions emit 5-10 events. The 100/15min global limiter would bite for
// rapid navigation. 200/15min per IP is generous; abusive volume gets
// silently dropped without affecting the rest of the API.
const funnelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { accepted: false, reason: 'rate_limited' },
  standardHeaders: false,
  legacyHeaders: false,
});

// Mount funnel BEFORE the global limiter and its own dedicated route so the
// 100/15min global gate does not apply.
app.use('/api/funnel', funnelLimiter, funnelRoutes);

// Pass 23 Bug 23.0c — anon-friendly payment-error telemetry. The whole
// point is logging mount/auth-edge failures that the standard authenticate
// middleware would 401 + swallow. Strict rate limit (10/min/IP) since this
// is anon-callable; abusive volume is dropped before reaching the route.
const paymentErrorsLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { logged: false, reason: 'rate_limited' },
  standardHeaders: false,
  legacyHeaders: false,
});
app.use('/api/payments/errors/log', paymentErrorsLogLimiter);

app.use('/api/', limiter);
app.use('/api/ai', aiLimiter);
app.use('/api/chat', chatLimiter);

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/results', resultsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/profile', profileRoutes);
// Pass 23 A9 — /api/notifications/* mount removed alongside the routes
// file delete. Frontend reads via supabase-js + RLS now.
app.use('/api/admin', adminRoutes);
// Pass 24 Bug 24.02 — admin costs panel (mounted under /api/admin/costs)
app.use('/api/admin/costs', adminCostsRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/crm', crmRoutes);  // Public lead capture — no auth required

// ─── Health Check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ─── Version endpoint — expose Railway's deployed git SHA so we can
// verify which commit is actually running. Bug 23.79 regression
// diagnostic: a "fix is in git" doesn't mean "fix is in prod" if the
// platform's auto-deploy hook silently skipped the build. This lets
// us prove what's running without dashboard access. Railway auto-sets
// RAILWAY_GIT_COMMIT_SHA on every build.
app.get('/version', (req, res) => {
  res.json({
    sha:       process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    branch:    process.env.RAILWAY_GIT_BRANCH || 'unknown',
    deployedAt: process.env.RAILWAY_DEPLOYMENT_CREATED_AT || 'unknown',
    bug23_79:  'magic-byte detection',
    bug23_80:  'auto-refund on pipeline failure',
  });
});

// ─── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info(`🚀 Vettit backend running on port ${PORT}`);
  logger.info(`📡 Environment: ${process.env.NODE_ENV}`);

  // Pass 22 Bug 22.10 — start mission recovery cron after the HTTP server
  // is up, so we don't block /health or first-request availability on the
  // first interval tick. Skipped in NODE_ENV=test (handled inside init).
  const missionRecovery = require('./jobs/missionRecovery');
  missionRecovery.init();
});

// Pass 22 Bug 22.10 — clean shutdown so Railway redeploys don't leave
// orphaned setInterval handles in old pods. SIGTERM is what Railway sends;
// SIGINT covers local Ctrl-C.
function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    require('./jobs/missionRecovery').shutdown();
  } catch (err) {
    logger.warn('missionRecovery.shutdown failed', { err: err?.message });
  }
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Hard cutoff if close() hangs (e.g. websockets we don't track)
  setTimeout(() => {
    logger.warn('Forcing exit after 10s grace period');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = app;
