'use strict';
// Real row shapes from production, September 2026.
const { isStripeCharged, grossStripeCents, netRevenueCents, sumNetRevenueUsd } = require('../src/services/payments/netRevenue');

const kept = { id: 'bae6613a', paid_at: '2026-07-02', paid_amount_cents: 900, refunded_amount_cents: 0, stripe_refund_ids: [], latest_payment_intent_id: 'pi_b', checkout_session_id: null };
const refunded = { id: '29716bfb', paid_at: '2026-05-14', paid_amount_cents: 900, refunded_amount_cents: 900, stripe_refund_ids: ['re_1'], latest_payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' };
const aprilNoPi = { id: '2d12aac7', paid_at: '2026-04-23', paid_amount_cents: 3500, refunded_amount_cents: 3500, stripe_refund_ids: ['re_7'], latest_payment_intent_id: null, checkout_session_id: null };
const adminOverride = { id: '3cd77b6c', paid_at: '2026-06-13', payment_method: 'admin_override', total_price_usd: '314.00', paid_amount_cents: null, refunded_amount_cents: 0, stripe_refund_ids: [], latest_payment_intent_id: null, checkout_session_id: null };
const paidNoCharge = { id: '23389bb1', paid_at: '2026-04-21', total_price_usd: '9.00', paid_amount_cents: 900, paid_amount_estimated: true, refunded_amount_cents: 0, stripe_refund_ids: [], latest_payment_intent_id: null, checkout_session_id: null };
const freePromo = { id: '10ecb820', paid_at: '2026-09-08', promo_code: 'VETT100', paid_amount_cents: null, refunded_amount_cents: 0, stripe_refund_ids: [], latest_payment_intent_id: null, checkout_session_id: null };
const partial = { ...kept, id: 'partial', paid_amount_cents: 1900, refunded_amount_cents: 760, stripe_refund_ids: ['re_p'] };
const unpaidDraft = { ...kept, id: 'draft', paid_at: null };

test('a kept Stripe charge is revenue', () => expect(netRevenueCents(kept)).toBe(900));
test('a refunded charge is not', () => expect(netRevenueCents(refunded)).toBe(0));
test('a partial refund keeps the difference', () => expect(netRevenueCents(partial)).toBe(1140));
test('an April charge with no stored PaymentIntent is recognised through its Stripe refund', () => {
  expect(isStripeCharged(aprilNoPi)).toBe(true);
  expect(grossStripeCents(aprilNoPi)).toBe(3500);
  expect(netRevenueCents(aprilNoPi)).toBe(0);
});
test('an admin override is not revenue, whatever its list price', () => expect(netRevenueCents(adminOverride)).toBe(0));
test('a mission marked paid with no Stripe charge is not revenue', () => {
  expect(isStripeCharged(paidNoCharge)).toBe(false);
  expect(netRevenueCents(paidNoCharge)).toBe(0);
});
test('a free promo mission is not revenue', () => expect(netRevenueCents(freePromo)).toBe(0));
test('a checkout session that was never paid is not revenue', () => expect(netRevenueCents(unpaidDraft)).toBe(0));
test('a refund larger than the recorded charge never makes revenue negative', () => expect(netRevenueCents({ ...kept, refunded_amount_cents: 5000 })).toBe(0));
test('the production mix sums to $9.00', () => {
  expect(sumNetRevenueUsd([kept, refunded, aprilNoPi, adminOverride, paidNoCharge, freePromo])).toBe(9);
});

test('the SQL helper states the same rule', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', 'pass-59', '01_net_revenue_rpcs.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.mission_net_revenue_cents'), sql.indexOf('$fn$;'));
  expect(fn).toMatch(/m\.paid_at IS NOT NULL/);
  expect(fn).toMatch(/m\.latest_payment_intent_id IS NOT NULL/);
  expect(fn).toMatch(/m\.checkout_session_id IS NOT NULL/);
  expect(fn).toMatch(/cardinality\(m\.stripe_refund_ids\) > 0/);
  expect(fn).toMatch(/GREATEST\(COALESCE\(m\.paid_amount_cents, 0\) - m\.refunded_amount_cents, 0\)/);
  expect(fn).not.toMatch(/total_price_usd/);
  // Every RPC that reports revenue goes through the helper, and none reads the list price.
  for (const rpc of ['admin_ai_cost_summary', 'daily_revenue_buckets', 'admin_user_segments', 'admin_activity_feed']) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${rpc}(`);
    const body = sql.slice(start, sql.indexOf('$function$;', start));
    expect(body).toMatch(/mission_net_revenue_cents\(m\)/);
    expect(body).not.toMatch(/total_price_usd/);
  }
});

test('no admin revenue figure reads the list price any more', () => {
  const fs = require('fs');
  const admin = fs.readFileSync(require.resolve('../src/routes/admin.js'), 'utf8');
  const costs = fs.readFileSync(require.resolve('../src/routes/adminCosts.js'), 'utf8');
  const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  expect(code(admin)).not.toMatch(/Number\(m\.total_price_usd|Number\(r\.total_price_usd/);
  expect(code(costs)).not.toMatch(/total_price_usd \* 100/);
  expect(code(costs)).not.toMatch(/paid_missions \* 0\.30/);
});
