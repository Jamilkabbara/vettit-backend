/**
 * POST /api/crm/lead  — public, no auth required.
 * Captures marketing leads from the landing page, dashboard banner, etc.
 * Rate-limited by IP (5 requests / hour, in-memory for MVP).
 * Dedupes on email — if exists, appends new source + timestamp to notes.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

// ---- Simple in-memory rate limiter: Map<ip, { count, resetAt }> ----------
const ipCounter = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = ipCounter.get(ip);
  if (!rec || now > rec.resetAt) {
    ipCounter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count += 1;
  return true;
}

// Periodically prune stale entries so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipCounter.entries()) {
    if (now > rec.resetAt) ipCounter.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);

// --------------------------------------------------------------------------

router.post('/lead', async (req, res, next) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { email, name, company, page, utm_source, utm_medium, utm_campaign, cta } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    const sourceData = {
      page: page || 'unknown',
      cta: cta || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      captured_at: new Date().toISOString(),
    };

    // Check for existing lead with this email
    const { data: existing } = await supabase
      .from('crm_leads')
      .select('id, notes, source')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existing) {
      // Append new source touch to notes
      const appendNote = `[${new Date().toISOString()}] Re-engaged via ${sourceData.page}${sourceData.cta ? ` (${sourceData.cta})` : ''}.`;
      const updatedNotes = existing.notes ? `${existing.notes}\n${appendNote}` : appendNote;
      await supabase
        .from('crm_leads')
        .update({ notes: updatedNotes, last_activity_at: new Date().toISOString() })
        .eq('id', existing.id);
      logger.info('CRM lead re-engaged', { email: email.toLowerCase().trim(), page });
    } else {
      // New lead
      await supabase.from('crm_leads').insert({
        email: email.toLowerCase().trim(),
        name: name || null,
        company: company || null,
        stage: 'new_lead',
        source: sourceData,
      });
      logger.info('CRM lead captured', { email: email.toLowerCase().trim(), page });
    }

    // Never expose existing lead data — just success.
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
