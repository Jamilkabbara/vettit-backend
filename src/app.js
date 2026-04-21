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
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const blogRoutes = require('./routes/blog');
const chatRoutes = require('./routes/chat');
const pricingRoutes = require('./routes/pricing');
const crmRoutes = require('./routes/crm');

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
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/crm', crmRoutes);  // Public lead capture — no auth required

// ─── Health Check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ─── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`🚀 Vettit backend running on port ${PORT}`);
  logger.info(`📡 Environment: ${process.env.NODE_ENV}`);
});

module.exports = app;
