const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

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

// GET /api/profile/invoices — get all paid missions as invoices
router.get('/invoices', authenticate, async (req, res, next) => {
  try {
    // Canonical column names as of 2026-04-23 schema audit.
    // Removed: mission_statement (→ brief/title), price (→ total_price_usd),
    //          pricing_breakdown (→ individual cost columns), launched_at (→ paid_at),
    //          stripe_payment_intent_id (not stored on missions; Stripe is source of truth).
    const { data, error } = await supabase
      .from('missions')
      .select('id, title, brief, total_price_usd, base_cost_usd, targeting_surcharge_usd, extra_questions_cost_usd, discount_usd, promo_code, respondent_count, paid_at, status')
      .eq('user_id', req.user.id)
      .in('status', ['paid', 'completed'])
      .not('paid_at', 'is', null)
      .order('paid_at', { ascending: false });

    if (error) throw error;

    const invoices = (data || []).map(m => ({
      invoiceId:        `VTT-${m.id.substring(0, 8).toUpperCase()}`,
      missionId:        m.id,
      missionStatement: m.brief || m.title || '',
      amount:           Number(m.total_price_usd) || 0,
      breakdown: {
        base:               Number(m.base_cost_usd)              || 0,
        targetingSurcharge: Number(m.targeting_surcharge_usd)    || 0,
        extraQuestionsCost: Number(m.extra_questions_cost_usd)   || 0,
        discount:           Number(m.discount_usd)               || 0,
        promoCode:          m.promo_code                         || null,
      },
      respondentCount: m.respondent_count,
      date:            m.paid_at,
      status:          'paid',
      paymentIntentId: null, // not stored on missions; Stripe is the record of truth
    }));

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
