/**
 * A mission VETT ran itself is not a bill.
 *
 * 11 test missions were run on an admin override: no card, no Stripe, nothing
 * owed. `paid_amount_cents` is null on every one, so the invoice builder fell
 * back to the LIST price and produced invoices totalling $849 for money nobody
 * paid and nobody owed. The customer-facing invoice tab showed them as charges.
 *
 * Revenue never counted them - an override has no Stripe charge, and net
 * revenue only counts what Stripe captured (services/payments/netRevenue.js).
 * That is exactly why the invoice must not price them either: the two surfaces
 * were telling different stories about the same mission.
 */

const { buildInvoice, paidVia } = require('../src/services/invoices/buildInvoice');
const { netRevenueCents, sumNetRevenueUsd } = require('../src/services/payments/netRevenue');

/** The shape of the real rows: a list price, and no capture. */
const override = (over = {}) => ({
  id: '2f909afe-0000-0000-0000-000000000000',
  goal_type: 'research',
  brief: 'A mission VETT ran',
  respondent_count: 5,
  payment_method: 'admin_override',
  total_price_usd: '14.00',
  base_cost_usd: '9.00',
  targeting_surcharge_usd: '5.00',
  extra_questions_cost_usd: '0.00',
  discount_usd: '0.00',
  paid_amount_cents: null,
  paid_at: '2026-06-13T00:00:00Z',
  refunded_amount_cents: 0,
  stripe_refund_ids: [],
  ...over,
});

describe('an admin-override mission', () => {
  test('THE BUG: it is invoiced at $0, not at its list price', () => {
    const inv = buildInvoice(override());
    expect(inv.total).toBe(0);
    expect(inv.net).toBe(0);
    expect(inv.amount).toBe(0);
    expect(inv.providedByVett).toBe(true);
    expect(inv.paidVia).toBe('admin');
  });

  test('no line pretends to be a charge', () => {
    const inv = buildInvoice(override());
    expect(inv.lines).toEqual({ base: 0, targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 });
    expect(inv.itemised).toBe(false);
  });

  test('the 11 real missions come to $0, not $849', () => {
    // The real list prices: one at $9 and ten at $14 and up, summing to $849.
    const prices = ['9.00', '14.00', '14.00', '14.00', '14.00', '14.00', '14.00', '314.00', '14.00', '214.00', '214.00'];
    const invoices = prices.map((p, i) => buildInvoice(override({
      id: `0000000${i}-0000-0000-0000-00000000000${i}`, total_price_usd: p,
    })));
    expect(prices.reduce((s, p) => s + Number(p), 0)).toBe(849);       // what they used to bill
    expect(invoices.reduce((s, inv) => s + inv.total, 0)).toBe(0);     // what they bill now
    expect(invoices.every((inv) => inv.providedByVett)).toBe(true);
  });

  test('and revenue does not move, because it never counted them', () => {
    const rows = Array.from({ length: 11 }, () => override());
    expect(rows.every((r) => netRevenueCents(r) === 0)).toBe(true);
    expect(sumNetRevenueUsd(rows)).toBe(0);
  });
});

describe('everything else is untouched', () => {
  test('a Stripe charge still bills what was charged, itemised', () => {
    const inv = buildInvoice(override({
      payment_method: 'card', paid_amount_cents: 1400, latest_payment_intent_id: 'pi_1',
    }));
    expect(inv).toMatchObject({ paidVia: 'stripe', total: 14, net: 14, providedByVett: false, itemised: true });
    expect(inv.lines).toEqual({ base: 9, targetingSurcharge: 5, extraQuestionsCost: 0, discount: 0 });
  });

  test('a free promo mission still reads as a promo at $0, not as provided by VETT', () => {
    const inv = buildInvoice(override({ payment_method: null, promo_code: 'VETTPROOF', total_price_usd: '0.00' }));
    expect(inv).toMatchObject({ paidVia: 'promo', total: 0, providedByVett: false, promoCode: 'VETTPROOF' });
  });

  test('a refunded Stripe charge still shows the charge and the refund', () => {
    const inv = buildInvoice(override({
      payment_method: 'card', paid_amount_cents: 1400, latest_payment_intent_id: 'pi_2',
      refunded_amount_cents: 1400, stripe_refund_ids: ['re_1'],
    }));
    expect(inv).toMatchObject({ total: 14, refunded: 14, net: 0, status: 'refunded', providedByVett: false });
  });

  test('paidVia is unchanged: an override is an override', () => {
    expect(paidVia(override())).toBe('admin');
  });
});
