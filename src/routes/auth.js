const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const emailService = require('../services/email');
const logger = require('../utils/logger');

// POST /api/auth/register — called after Supabase signup to send welcome email
router.post('/register', async (req, res, next) => {
  try {
    const { userId, email, name } = req.body;
    if (!userId || !email) return res.status(400).json({ error: 'userId and email are required' });

    // Pass 21 Bug 10: do NOT upsert with full_name: name || ''. The
    // public.handle_new_user() trigger has already populated the profile
    // from auth.users.raw_user_meta_data (including OAuth providers); a
    // blind upsert with an empty name string would overwrite "Jamil
    // Kabbara" with "" the next time the frontend calls this endpoint
    // without a name. Only patch the row when we actually have a name,
    // and even then never write an empty string. (`updated_at` is also
    // dropped — that column does not exist on profiles.)
    if (typeof name === 'string' && name.trim().length > 0) {
      await supabase.from('profiles').upsert({
        id: userId,
        full_name: name.trim(),
      }, { onConflict: 'id' });
    }

    // Send welcome email
    await emailService.sendWelcomeEmail({ to: email, name }).catch(e =>
      logger.warn('Failed to send welcome email', { error: e.message })
    );

    logger.info('New user registered', { userId, email });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — get current user info
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { data: { user }, error } = await supabase.auth.admin.getUserById(req.user.id);
    if (error) throw error;

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    res.json({
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
      profile: profile || {},
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/account — Pass 21 Bug 12.
//
// Permanently deletes the authenticated user and all their owned data.
// Body must contain { confirm: 'DELETE' } to gate accidental wipes.
//
// Order matters because public.* tables don't have ON DELETE CASCADE on
// auth.users, and missions has NO ACTION on its profile FK. We must:
//
//   1. Delete child rows that block missions deletion (ai_calls,
//      chat_sessions — both NO ACTION on missions FK).
//   2. Delete user-owned rows in tables with no FK to missions
//      (notifications, funnel_events, crm_leads, support_tickets,
//      admin_alerts, admin_user_notes, payment_errors).
//   3. Delete missions (cascades mission_responses; SET NULL on
//      admin_alerts/funnel_events/payment_errors mission_id).
//   4. Delete profiles row.
//   5. Delete auth.users row via admin API.
//
// We do NOT delete the Stripe customer — that's a separate operation
// the user (or support) can request if needed; preserving the customer
// keeps the historical invoice audit trail intact at Stripe.
// ─────────────────────────────────────────────────────────────────────────
router.delete('/account', authenticate, async (req, res, next) => {
  const userId = req.user.id;
  const { confirm } = req.body || {};
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: "Confirmation token must be 'DELETE'" });
  }

  logger.info('Account deletion: starting', { userId, email: req.user.email });

  // Each step is best-effort: if one table errors we still try the rest,
  // since a partial cleanup is preferable to a half-deleted account.
  const steps = [
    ['ai_calls',         { user_id: userId }],
    ['chat_sessions',    { user_id: userId }], // cascades chat_messages
    ['notifications',    { user_id: userId }],
    ['funnel_events',    { user_id: userId }],
    ['crm_leads',        { user_id: userId }],
    ['support_tickets',  { user_id: userId }],
    ['admin_alerts',     { user_id: userId }],
    ['admin_user_notes', { user_id: userId }], // soft-FK; rows authored about the user
    ['payment_errors',   { user_id: userId }],
    ['missions',         { user_id: userId }], // cascades mission_responses
  ];

  const errors = [];
  for (const [table, match] of steps) {
    const { error: delErr } = await supabase.from(table).delete().match(match);
    if (delErr) {
      logger.warn('Account deletion: child table delete failed', {
        userId, table, err: delErr.message,
      });
      errors.push({ table, message: delErr.message });
    }
  }

  // Profiles row (PK, not user_id)
  const { error: profileErr } = await supabase.from('profiles').delete().eq('id', userId);
  if (profileErr) {
    logger.warn('Account deletion: profiles delete failed', { userId, err: profileErr.message });
    errors.push({ table: 'profiles', message: profileErr.message });
  }

  // Finally, the auth.users row. Failure here is fatal — without it the
  // user can still log in even though their data is gone.
  const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
  if (authErr) {
    logger.error('Account deletion: auth.users delete failed', {
      userId, err: authErr.message,
    });
    return res.status(500).json({
      error: 'Failed to delete auth user — your data was wiped but the login still exists. Contact hello@vettit.ai.',
      details: authErr.message,
      partialErrors: errors,
    });
  }

  logger.info('Account deletion: complete', { userId, partialErrors: errors.length });
  res.json({
    success: true,
    deleted: userId,
    // Surface non-fatal errors so the client can log them but they don't block.
    partialErrors: errors,
  });
});

module.exports = router;
