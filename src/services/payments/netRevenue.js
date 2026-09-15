'use strict';
/**
 * Revenue is money VETT kept: what Stripe captured for a mission, minus what
 * Stripe refunded. One rule, used by every admin and business figure, and
 * mirrored exactly by public.mission_net_revenue_cents() in SQL
 * (migrations/pass-59) for the RPCs.
 *
 * WHY
 * Admin revenue summed missions.total_price_usd over paid/completed missions.
 * That is a list price, not money: it counted 11 admin-override missions that
 * were never charged ($849), a mission marked paid with no Stripe charge at
 * all ($9), and 21 Stripe charges that were refunded in full ($365.60). The
 * headline read $1,194.60 while the business had kept $9.00.
 *
 * RULES
 * - A mission earns revenue only if Stripe charged it. Evidence of a Stripe
 *   charge is a stored PaymentIntent, a checkout session, or a recorded Stripe
 *   refund (seven April missions were charged without storing the PI).
 * - Net = paid_amount_cents - refunded_amount_cents, never below zero.
 * - Everything else is $0 of revenue: admin overrides, 100%-off promos, and
 *   rows marked paid with no charge. They still cost AI spend.
 * - Stripe fees are charged on the capture and not returned on refund, so fee
 *   estimates use grossStripeCents(), not net.
 */

const NET_REVENUE_COLUMNS = 'paid_at, paid_amount_cents, refunded_amount_cents, stripe_refund_ids, latest_payment_intent_id, checkout_session_id';

function isStripeCharged(m) {
  if (!m || !m.paid_at) return false;
  return Boolean(m.latest_payment_intent_id || m.checkout_session_id || (Array.isArray(m.stripe_refund_ids) && m.stripe_refund_ids.length > 0));
}

function grossStripeCents(m) {
  return isStripeCharged(m) ? Math.max(Number(m.paid_amount_cents) || 0, 0) : 0;
}

function netRevenueCents(m) {
  if (!isStripeCharged(m)) return 0;
  return Math.max(grossStripeCents(m) - (Number(m.refunded_amount_cents) || 0), 0);
}

const netRevenueUsd = (m) => netRevenueCents(m) / 100;

/** Sum over rows, in dollars, rounded to the cent. */
function sumNetRevenueUsd(rows) {
  return (rows || []).reduce((s, m) => s + netRevenueCents(m), 0) / 100;
}

module.exports = { NET_REVENUE_COLUMNS, isStripeCharged, grossStripeCents, netRevenueCents, netRevenueUsd, sumNetRevenueUsd };
