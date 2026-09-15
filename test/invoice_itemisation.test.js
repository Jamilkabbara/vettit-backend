'use strict';
// Rows below are the shapes of real paid missions in production (ids shortened).
const { buildInvoice } = require('../src/services/invoices/buildInvoice');
const sum = (inv) => Math.round((inv.lines.base + inv.lines.targetingSurcharge + inv.lines.extraQuestionsCost - inv.lines.discount) * 100) / 100;

describe('buildInvoice', () => {
  test('Stripe charge: total is the capture, lines sum to it', () => {
    const inv = buildInvoice({ id: '3348d47b-0000', goal_type: 'creative_attention', base_cost_usd: '19.00', targeting_surcharge_usd: '0.00', extra_questions_cost_usd: '0.00', discount_usd: '0.00', promo_code: null, total_price_usd: '19.00', paid_amount_cents: 1900, latest_payment_intent_id: 'pi_x', paid_at: '2026-05-01', respondent_count: 1 });
    expect(inv).toMatchObject({ paidVia: 'stripe', itemised: true, total: 19, goalType: 'creative_attention' });
    expect(sum(inv)).toBe(inv.total);
  });

  test('targeting and extra questions are itemised and sum to the total', () => {
    const inv = buildInvoice({ id: '3cd77b6c-0000', goal_type: 'naming_messaging', base_cost_usd: '9.00', targeting_surcharge_usd: '5.00', extra_questions_cost_usd: '300.00', discount_usd: '0.00', total_price_usd: '314.00', paid_amount_cents: null, payment_method: 'admin_override', paid_at: '2026-06-13', respondent_count: 5 });
    expect(inv.lines).toEqual({ base: 9, targetingSurcharge: 5, extraQuestionsCost: 300, discount: 0 });
    expect(inv).toMatchObject({ paidVia: 'admin', itemised: true, total: 314 });
    expect(sum(inv)).toBe(314);
  });

  test('a discount and its promo code appear, and still sum to what was captured', () => {
    const inv = buildInvoice({ id: 'aaaaaaaa-0000', goal_type: 'pricing', base_cost_usd: '149.00', targeting_surcharge_usd: '1.50', extra_questions_cost_usd: '10.00', discount_usd: '32.10', promo_code: 'SAVE20', total_price_usd: '128.40', paid_amount_cents: 12840, latest_payment_intent_id: 'pi_y', paid_at: '2026-09-01', respondent_count: 100 });
    expect(inv.lines.discount).toBe(32.1);
    expect(inv.promoCode).toBe('SAVE20');
    expect(sum(inv)).toBe(128.4);
    expect(inv.total).toBe(128.4);
  });

  test('100%-off promo never sent to Stripe: $0, code named, no invented list price', () => {
    const inv = buildInvoice({ id: '10ecb820-0000', goal_type: 'compare', base_cost_usd: null, targeting_surcharge_usd: null, extra_questions_cost_usd: '0.00', discount_usd: '0.00', promo_code: 'VETT100', total_price_usd: null, paid_amount_cents: null, price_estimated: '548', paid_at: '2026-09-08', respondent_count: 240 });
    expect(inv).toMatchObject({ paidVia: 'promo', total: 0, promoCode: 'VETT100' });
    expect(inv.lines).toEqual({ base: 0, targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 });
  });

  test('a breakdown that does not sum to the charge is not shown itemised', () => {
    const inv = buildInvoice({ id: 'bbbbbbbb-0000', base_cost_usd: '9.00', targeting_surcharge_usd: '5.00', extra_questions_cost_usd: '0.00', discount_usd: '0.00', total_price_usd: '9.00', paid_amount_cents: 900, latest_payment_intent_id: 'pi_z', paid_at: '2026-09-01', respondent_count: 5 });
    expect(inv.itemised).toBe(false);
    expect(inv.lines).toEqual({ base: 9, targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 });
    expect(sum(inv)).toBe(inv.total);
  });

  test('the capture wins over a stale total_price_usd', () => {
    const inv = buildInvoice({ id: 'cccccccc-0000', base_cost_usd: '35.00', targeting_surcharge_usd: '0', extra_questions_cost_usd: '0', discount_usd: '0', total_price_usd: '35.00', paid_amount_cents: 2750, latest_payment_intent_id: 'pi_w', paid_at: '2026-04-28', respondent_count: 10 });
    expect(inv.total).toBe(27.5);
    expect(inv.itemised).toBe(false);
  });
});

describe('refunds on invoices', () => {
  // af36a36d: charged $9 through Stripe, refunded $9 in full (the legacy
  // partial_refund_amount_cents of $3.60 is superseded and not read).
  const charged = { id: 'af36a36d-0000', goal_type: 'brand_lift', base_cost_usd: '9.00', targeting_surcharge_usd: '0.00', extra_questions_cost_usd: '0.00', discount_usd: '0.00', total_price_usd: '9.00', paid_amount_cents: 900, latest_payment_intent_id: 'pi_a', paid_at: '2026-04-28', respondent_count: 5, partial_refund_amount_cents: 360 };

  test('a fully refunded charge reads refunded, never paid, and nets to zero', () => {
    const inv = buildInvoice({ ...charged, refunded_amount_cents: 900, stripe_refund_ids: ['re_1'] });
    expect(inv).toMatchObject({ status: 'refunded', total: 9, refunded: 9, net: 0 });
    expect(inv.status).not.toBe('paid');
  });

  test('a partial refund reads partially refunded with the kept amount as net', () => {
    const inv = buildInvoice({ ...charged, paid_amount_cents: 1900, total_price_usd: '19.00', base_cost_usd: '19.00', refunded_amount_cents: 360 });
    expect(inv).toMatchObject({ status: 'partially_refunded', total: 19, refunded: 3.6, net: 15.4 });
  });

  test('no refund: paid, and net equals the charge', () => {
    const inv = buildInvoice({ ...charged, refunded_amount_cents: 0 });
    expect(inv).toMatchObject({ status: 'paid', total: 9, refunded: 0, net: 9 });
  });

  test('the charged lines still sum to total; the refund is its own line, not a discount', () => {
    const inv = buildInvoice({ ...charged, refunded_amount_cents: 900 });
    expect(sum(inv)).toBe(inv.total);
    expect(inv.lines.discount).toBe(0);
  });

  test('a mission charged in April without its PaymentIntent stored is still paid via Stripe', () => {
    const inv = buildInvoice({ ...charged, latest_payment_intent_id: null, paid_amount_cents: 3500, total_price_usd: '35.00', base_cost_usd: '35.00', refunded_amount_cents: 3500, stripe_refund_ids: ['re_7'] });
    expect(inv).toMatchObject({ paidVia: 'stripe', status: 'refunded', net: 0 });
  });

  test('a free promo mission is paid at $0, not refunded', () => {
    const inv = buildInvoice({ id: '10ecb820-0000', promo_code: 'VETT100', paid_amount_cents: null, total_price_usd: null, paid_at: '2026-09-08', refunded_amount_cents: 0 });
    expect(inv).toMatchObject({ status: 'paid', total: 0, net: 0, refunded: 0 });
  });
});
