const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { buildInvoice } = require('../services/invoices/buildInvoice');

// GET /api/profile — get current user's profile
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found

    // Get auth user email
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    res.json({
      id: req.user.id,
      email: user.email,
      profile: data || {},
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile — update profile
router.patch('/', authenticate, async (req, res, next) => {
  try {
    const { full_name, company_name, tax_id, address_line1, address_line2, city, state, postal_code, country } = req.body;

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: req.user.id,
        full_name,
        company_name,
        tax_id,
        address_line1,
        address_line2,
        city,
        state,
        postal_code,
        country,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/invoices — one invoice per mission that was paid for
router.get('/invoices', authenticate, async (req, res, next) => {
  try {
    // Every mission with a paid_at, whatever happened to it afterwards: a
    // mission that was charged and then failed was still paid for, and used
    // to have no invoice because this read only 'paid' and 'completed'.
    const { data, error } = await supabase
      .from('missions')
      .select('id, title, brief, goal_type, status, respondent_count, paid_at, total_price_usd, base_cost_usd, targeting_surcharge_usd, extra_questions_cost_usd, discount_usd, promo_code, paid_amount_cents, payment_method, latest_payment_intent_id')
      .eq('user_id', req.user.id)
      .not('paid_at', 'is', null)
      .order('paid_at', { ascending: false });

    if (error) throw error;

    const invoices = (data || []).map(buildInvoice);

    res.json(invoices);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile/password — change password
router.patch('/password', authenticate, async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password: newPassword });
    if (error) throw error;

    logger.info('Password changed', { userId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
