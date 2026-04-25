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

module.exports = router;
