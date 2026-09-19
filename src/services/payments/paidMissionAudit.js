'use strict';
/**
 * Every mission marked paid must be explained: a matching Stripe charge, a
 * promo code that exists, an admin override with a written reason, or a
 * reviewed historical exception listed below. Anything else is a problem.
 *
 * WHY
 * This class keeps recurring. A $9 mission read as paid for five months with
 * no Stripe charge behind it (a client-side free launch wrote paid_at from the
 * browser, and a later backfill copied its list price into paid_amount_cents).
 * Seven April missions were charged but never stored their PaymentIntent.
 * Three internal test runs were inserted already paid, with no reason at all.
 * None of it was visible until someone reconciled Stripe by hand.
 *
 * Runs daily from the recovery cron (alerting admins, deduplicated per
 * mission) and on demand with scripts/check-paid-missions.js, which exits 1.
 */
const { readMissionStripeState } = require('./syncMissionRefunds');

/**
 * Reviewed exceptions, each investigated against Stripe and the code history
 * on 2026-09-15. Adding a mission here is a decision, not a fix: it says the
 * row is wrong-looking but understood. Rows are not rewritten.
 */
const PAID_WITHOUT_CHARGE_EXCEPTIONS = Object.freeze({
  '23389bb1-b30f-4b33-a450-37ded4560307': 'Owner test mission, 21 Apr 2026. Marked paid by the old client-side free-launch path the day before VETT took its first live payment; no Stripe activity exists for it. Its $9 paid_amount_cents was estimated by the Pass 29 backfill, not charged.',
  '3fc15087-1432-468e-bc97-3b2776cccb88': 'Internal [UN-GATE TEST] market_entry run, 25 Aug 2026, inserted already paid at $0.',
  '0cb85100-9fcc-4b86-8658-63566b170040': 'Internal [UN-GATE TEST] creative_attention run, 31 Aug 2026, inserted already paid with no amount.',
  '5a07eaf8-a713-4411-aa5b-ae41b628f0ff': 'Internal [UN-GATE TEST] audience_profiling run, 31 Aug 2026, inserted already paid at $0.',
});

const AUDIT_COLUMNS = 'id, title, paid_at, paid_amount_cents, refunded_amount_cents, stripe_refund_ids, latest_payment_intent_id, checkout_session_id, promo_code, payment_method, rejected_payment_intent_ids';

/**
 * Explain one paid mission. `ctx` carries what was read once for the batch:
 * the Stripe state for this mission, the promo codes that exist, and the
 * missions with an admin mark-paid audit entry that states a reason.
 */
function explainPaidMission(m, { stripeState, promoCodes, overrideReasons, exceptions = PAID_WITHOUT_CHARGE_EXCEPTIONS }) {
  const out = (explanation, problem = null, detail = null) => ({ missionId: m.id, explanation, ok: !problem, problem, detail });
  const charged = stripeState && stripeState.paymentIntentIds.length > 0;

  if (charged) {
    if (m.paid_amount_cents != null && Number(m.paid_amount_cents) !== stripeState.capturedCents) {
      return out('stripe', 'recorded_amount_differs_from_stripe', `recorded ${m.paid_amount_cents} cents, Stripe captured ${stripeState.capturedCents}`);
    }
    if (Number(m.refunded_amount_cents || 0) !== stripeState.refundedCents) {
      return out('stripe', 'recorded_refund_differs_from_stripe', `recorded ${m.refunded_amount_cents || 0} cents refunded, Stripe ${stripeState.refundedCents}`);
    }
    return out('stripe');
  }
  if (m.latest_payment_intent_id || (m.stripe_refund_ids && m.stripe_refund_ids.length)) {
    return out('none', 'stripe_reference_without_charge', 'the row names a Stripe payment or refund, but Stripe has no succeeded charge for this mission');
  }
  if (m.payment_method === 'admin_override') {
    return overrideReasons.has(m.id) ? out('admin_override') : out('admin_override', 'override_without_reason', 'no admin mark-paid audit entry with a reason');
  }
  if (m.promo_code) {
    if (!promoCodes.has(String(m.promo_code).toUpperCase())) return out('promo', 'unknown_promo_code', `promo code is not in promo_codes`);
    if (Number(m.paid_amount_cents || 0) > 0) return out('promo', 'promo_with_uncharged_amount', `${m.paid_amount_cents} cents recorded as paid with no Stripe charge`);
    return out('promo');
  }
  if (exceptions[m.id]) return out('reviewed_exception');
  return out('none', 'paid_without_charge_or_reason', 'marked paid with no Stripe charge, no promo code and no admin override');
}

/** Audit every paid mission. Read-only. */
async function auditPaidMissions({ supabase, stripe }) {
  const { data: missions, error } = await supabase.from('missions').select(AUDIT_COLUMNS).not('paid_at', 'is', null).order('paid_at', { ascending: true });
  if (error) throw error;
  const { data: promos, error: promoErr } = await supabase.from('promo_codes').select('code');
  if (promoErr) throw promoErr;
  const { data: actions, error: actErr } = await supabase.from('admin_actions').select('target_id, reason').eq('action_type', 'mark_mission_paid');
  if (actErr) throw actErr;

  const promoCodes = new Set((promos || []).map((p) => String(p.code).toUpperCase()));
  const overrideReasons = new Set((actions || []).filter((a) => a.reason && String(a.reason).trim()).map((a) => String(a.target_id)));
  const results = [];
  for (const m of missions || []) {
    const stripeState = await readMissionStripeState(stripe, m);
    results.push({ ...explainPaidMission(m, { stripeState, promoCodes, overrideReasons }), title: m.title });
  }
  return results;
}

module.exports = { explainPaidMission, auditPaidMissions, PAID_WITHOUT_CHARGE_EXCEPTIONS, AUDIT_COLUMNS };
