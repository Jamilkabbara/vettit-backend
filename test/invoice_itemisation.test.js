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
