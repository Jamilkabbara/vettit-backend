// Pass 24 Bug 24.02 — admin costs panel.
// Mounted under /api/admin/costs (admin-only via authenticate + adminOnly).

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

router.use(authenticate, adminOnly);

function monthRange(yearOffset = 0, monthOffset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear() + yearOffset, now.getMonth() + monthOffset, 1);
  const end = new Date(now.getFullYear() + yearOffset, now.getMonth() + monthOffset + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function aggregateMonth(rangeStart, rangeEnd) {
  const { data: missions } = await supabase
    .from('missions')
    .select('id, goal_type, paid_at, paid_amount_cents, total_price_usd')
    .gte('paid_at', rangeStart)
    .lt('paid_at', rangeEnd)
    .not('paid_at', 'is', null);

  let revenue_cents = 0;
  for (const m of (missions || [])) {
    revenue_cents += (m.paid_amount_cents || (m.total_price_usd ? Math.round(m.total_price_usd * 100) : 0));
  }
  const revenue_usd = revenue_cents / 100;
  const paid_missions = (missions || []).length;

  const { data: aiCalls } = await supabase
    .from('ai_calls')
    .select('cost_usd')
    .gte('created_at', rangeStart)
    .lt('created_at', rangeEnd);
  const ai_cost_usd = (aiCalls || []).reduce((s, c) => s + Number(c.cost_usd || 0), 0);

  const { data: vendors } = await supabase
    .from('vendor_costs')
    .select('cost_usd, category')
    .or('effective_to.is.null,effective_to.gte.' + rangeStart);
  const fixed_monthly = (vendors || [])
    .filter(v => v.category === 'fixed_monthly')
    .reduce((s, v) => s + Number(v.cost_usd || 0), 0);
  const annual_monthlyized = (vendors || [])
    .filter(v => v.category === 'annual')
    .reduce((s, v) => s + Number(v.cost_usd || 0) / 12, 0);

  const stripe_fees_usd = paid_missions * 0.30 + revenue_usd * 0.029;
  const cost_usd = ai_cost_usd + stripe_fees_usd + fixed_monthly + annual_monthlyized;

  const net_contribution_usd = revenue_usd - cost_usd;
  const gross_margin_pct = revenue_usd > 0 ? (net_contribution_usd / revenue_usd) * 100 : 0;

  return {
    revenue_usd: Math.round(revenue_usd * 100) / 100,
    cost_usd: Math.round(cost_usd * 100) / 100,
    net_contribution_usd: Math.round(net_contribution_usd * 100) / 100,
    gross_margin_pct: Math.round(gross_margin_pct * 10) / 10,
    paid_missions,
  };
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const thisMonth = monthRange(0, 0);
    const lastMonth = monthRange(0, -1);
    const last30 = {
      start: new Date(Date.now() - 30 * 86400000).toISOString(),
      end: new Date().toISOString(),
    };

    const [thisAgg, lastAgg, vendorsRes, aiByModelRes, aiFailedRes, perGoalRes, dbSizeRes] = await Promise.all([
      aggregateMonth(thisMonth.start, thisMonth.end),
      aggregateMonth(lastMonth.start, lastMonth.end),
      supabase.from('vendor_costs').select('vendor, display_name, category, cost_usd, cost_unit, notes')
        .is('effective_to', null).order('display_name'),
      supabase.from('ai_calls').select('model, cost_usd')
        .gte('created_at', last30.start).lt('created_at', last30.end),
      supabase.from('ai_calls').select('id', { count: 'exact', head: true })
        .eq('success', false).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()),
      supabase.from('missions')
        .select('goal_type, paid_at, paid_amount_cents, total_price_usd')
        .not('paid_at', 'is', null),
      supabase.rpc('pg_database_size', { db: 'postgres' }).then(r => r, () => null),
    ]);

    const fixed_costs = (vendorsRes.data || [])
      .filter(v => v.category === 'fixed_monthly' || v.category === 'annual')
      .map(v => ({
        vendor: v.vendor,
        display_name: v.display_name,
        monthly_usd: v.category === 'annual' ? Math.round((v.cost_usd / 12) * 100) / 100 : Number(v.cost_usd),
        notes: v.notes,
      }));

    const aiByModel = {};
    for (const c of (aiByModelRes.data || [])) {
      const m = c.model || 'unknown';
      aiByModel[m] = aiByModel[m] || { calls: 0, cost_usd: 0 };
      aiByModel[m].calls++;
      aiByModel[m].cost_usd += Number(c.cost_usd || 0);
    }
    const variable_costs = {
      anthropic: {
        last_30d_usd: Math.round((aiByModelRes.data || []).reduce((s, c) => s + Number(c.cost_usd || 0), 0) * 100) / 100,
        lifetime_usd: 0,
        by_model: Object.entries(aiByModel).map(([model, v]) => ({ model, calls: v.calls, cost_usd: Math.round(v.cost_usd * 100) / 100 })),
        failed_calls: aiFailedRes.count || 0,
      },
      stripe: {
        estimated_30d_usd: Math.round((thisAgg.paid_missions * 0.30 + thisAgg.revenue_usd * 0.029) * 100) / 100,
        formula: '2.9% + $0.30 per successful charge',
      },
    };

    const perGoal = {};
    for (const m of (perGoalRes.data || [])) {
      const g = m.goal_type || 'unknown';
      perGoal[g] = perGoal[g] || { paid_missions: 0, revenue_cents: 0 };
      perGoal[g].paid_missions++;
      perGoal[g].revenue_cents += (m.paid_amount_cents || (m.total_price_usd ? Math.round(m.total_price_usd * 100) : 0));
    }
    const per_goal_type = Object.entries(perGoal).map(([goal_type, v]) => {
      const revenue_usd = v.revenue_cents / 100;
      return {
        goal_type,
        paid_missions: v.paid_missions,
        revenue_usd: Math.round(revenue_usd * 100) / 100,
        anthropic_cost_usd: 0,
        avg_revenue_per_mission: v.paid_missions > 0 ? Math.round((revenue_usd / v.paid_missions) * 100) / 100 : 0,
        avg_anthropic_cost_per_mission: 0,
        gross_margin_pct: null,
        has_revenue_gap: revenue_usd === 0 && v.paid_missions > 0,
      };
    });

    // Integrity warnings
    const { count: missingPaidCount } = await supabase
      .from('missions').select('id', { count: 'exact', head: true })
      .not('paid_at', 'is', null).is('paid_amount_cents', null);
    // Pass 29 A1 — count rows that were backfilled from total_price_usd
    // (estimated). These no longer trigger the critical warning, but
    // surface as an info-level note so future audits know which revenue
    // numbers are Stripe-confirmed vs estimated.
    const { count: estimatedPaidCount } = await supabase
      .from('missions').select('id', { count: 'exact', head: true })
      .eq('paid_amount_estimated', true);
    const integrity_warnings = [];
    if (missingPaidCount > 0) {
      integrity_warnings.push({
        severity: 'critical',
        code: 'missing_paid_amount_cents',
        title: 'Missions missing paid_amount_cents',
        description: `${missingPaidCount} missions have paid_at but no paid_amount_cents — Stripe webhook bug.`,
        affected_count: missingPaidCount,
        suggested_action: 'Fix Stripe webhook to populate paid_amount_cents on payment_intent.succeeded events.',
      });
    }
    if (estimatedPaidCount > 0) {
      integrity_warnings.push({
        severity: 'info',
        code: 'paid_amount_estimated',
        title: 'Revenue includes estimated paid amounts',
        description: `${estimatedPaidCount} missions have paid_amount_cents backfilled from total_price_usd (Pass 29 A1). Stripe-confirmed amounts are preferred for downstream reporting.`,
        affected_count: estimatedPaidCount,
        suggested_action: 'No action required. To replace estimates with Stripe-confirmed amounts, look up each mission\'s latest_payment_intent_id and read amount_received from the Stripe API.',
      });
    }
    if ((aiFailedRes.count || 0) >= 6) {
      integrity_warnings.push({
        severity: 'warning',
        code: 'failed_ai_calls',
        title: 'AI call failures (last 7 days)',
        description: `${aiFailedRes.count} ai_calls rows have success=false in the past 7 days.`,
        affected_count: aiFailedRes.count,
        suggested_action: 'Check ai_calls.error_message for the failing model and retry.',
      });
    }

    const capacity = {
      supabase_db_size_mb: 15,
      supabase_db_size_pct_of_free_tier: 3,
      resend_sends_this_month: null,
      railway_credits_remaining_usd: null,
    };

    res.json({
      generated_at: new Date().toISOString(),
      reporting_window: { start: thisMonth.start, end: thisMonth.end },
      this_month: thisAgg,
      last_month: lastAgg,
      fixed_costs,
      variable_costs,
      per_goal_type,
      integrity_warnings,
      capacity,
    });
  } catch (err) { next(err); }
});

router.get('/vendors', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('vendor_costs').select('*')
      .is('effective_to', null)
      .order('category').order('display_name');
    if (error) throw error;
    res.json({ vendors: data });
  } catch (err) { next(err); }
});

router.patch('/vendors/:id', async (req, res, next) => {
  try {
    const { cost_usd, notes, effective_to } = req.body;
    if (cost_usd != null && (Number(cost_usd) < 0 || isNaN(Number(cost_usd)))) {
      return res.status(400).json({ error: 'invalid_cost_usd' });
    }
    const patch = { updated_at: new Date().toISOString() };
    if (cost_usd != null) patch.cost_usd = Number(cost_usd);
    if (notes != null) patch.notes = notes;
    if (effective_to != null) patch.effective_to = effective_to;
    const { data, error } = await supabase
      .from('vendor_costs').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/vendors', async (req, res, next) => {
  try {
    const { vendor, display_name, category, cost_usd, cost_unit, notes, source } = req.body;
    if (!vendor || !display_name || !category || cost_usd == null || !cost_unit) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    if (Number(cost_usd) < 0) return res.status(400).json({ error: 'invalid_cost_usd' });
    const { data, error } = await supabase
      .from('vendor_costs')
      .insert({
        vendor, display_name, category,
        cost_usd: Number(cost_usd), cost_unit,
        notes: notes || null,
        source: source || 'manual',
      })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

module.exports = router;
