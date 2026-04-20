/**
 * adminOnly — gate that only lets kabbarajamil@gmail.com through.
 * Requires the `authenticate` middleware to have already populated req.user.
 */
const logger = require('../utils/logger');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'kabbarajamil@gmail.com';

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.email !== ADMIN_EMAIL) {
    logger.warn('Admin access denied', { userId: req.user.id, email: req.user.email });
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

module.exports = { adminOnly, ADMIN_EMAIL };
