/**
 * One invoice, built from a paid mission row.
 *
 * WHY
 * ---
 * GET /api/profile/invoices sent the cost breakdown nested under `breakdown`
 * while the invoice tab read flat base_cost_usd / discount_usd / promo_code /
 * goal_type, which were always undefined. Every downloaded invoice showed one
 * line, base = total, no discount, no promo code, no targeting or extra
 * question charges, goal type "research", and "Paid via Stripe" whether or not
 * Stripe was involved.
 *
 * RULES
 * -----
 * - total is what was charged: paid_amount_cents (the Stripe capture, or the
 *   recorded settlement) first, then total_price_usd. A mission paid with a
 *   100%-off promo code and never sent to Stripe has neither, and its total is
 *   0 with the code named.
 * - lines come from the stored cost columns. They are only shown itemised if
 *   they add up to the total to the cent; otherwise the invoice shows a single
 *   line for the amount charged and `itemised: false`, rather than a breakdown
 *   that does not sum.
 * - No list price is invented for a free-promo mission: price_estimated is a
 *   setup-time estimate and does not match the ladder for those rows.
 */
'use strict';

const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

function paidVia(m) {
  if (m.latest_payment_intent_id) return 'stripe';
  if (m.payment_method === 'admin_override') return 'admin';
  if (m.promo_code) return 'promo';
  return 'unrecorded';
}

function buildInvoice(m) {
  const via = paidVia(m);
  const totalCents =
    m.paid_amount_cents != null ? Number(m.paid_amount_cents)
      : cents(m.total_price_usd) != null ? cents(m.total_price_usd)
        : 0;   // free promo, or nothing recorded (paidVia says which)

  const base = cents(m.base_cost_usd) ?? 0;
  const targeting = cents(m.targeting_surcharge_usd) ?? 0;
  const extraQuestions = cents(m.extra_questions_cost_usd) ?? 0;
  const discount = cents(m.discount_usd) ?? 0;
  const itemised = m.base_cost_usd != null && base + targeting + extraQuestions - discount === totalCents;

  const lines = itemised
    ? { base, targetingSurcharge: targeting, extraQuestionsCost: extraQuestions, discount }
    : { base: totalCents, targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 };

  const usd = (c) => Math.round(c) / 100;
  return {
    invoiceId:        `VTT-${m.id.substring(0, 8).toUpperCase()}`,
    missionId:        m.id,
    missionStatement: m.brief || m.title || '',
    goalType:         m.goal_type || null,
    respondentCount:  m.respondent_count,
    date:             m.paid_at,
    status:           'paid',
    paidVia:          via,
    promoCode:        m.promo_code || null,
    itemised,
    lines: {
      base:               usd(lines.base),
      targetingSurcharge: usd(lines.targetingSurcharge),
      extraQuestionsCost: usd(lines.extraQuestionsCost),
      discount:           usd(lines.discount),
    },
    total:  usd(totalCents),
    amount: usd(totalCents),   // kept for older clients
  };
}

module.exports = { buildInvoice, paidVia };
