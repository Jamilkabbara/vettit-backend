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
const pollfishRoutes = require('./routes/pollfish');
const resultsRoutes = require('./routes/results');
const uploadsRoutes = require('./routes/uploads');
const profileRoutes = require('./routes/profile');
const webhookRoutes = require('./routes/webhooks');

const app = express();

// ─── Security ───────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://localhost:3000',
  ],
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
app.use('/api/', limiter);
app.use('/api/ai', aiLimiter);

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/pollfish', pollfishRoutes);
app.use('/api/results', resultsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/profile', profileRoutes);

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
