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
 * - An admin-override mission is $0. It was never charged and nothing is owed,
 *   so pricing it at the list price invoices the customer for money that was
 *   never taken. `providedByVett` is set and the payment note names VETT.
 * - Refunds (September 2026). `total` stays the amount charged, because that
 *   is what the customer bought; `refunded` is refunded_amount_cents, written
 *   from Stripe by the refund webhook, and `net` is what VETT kept. A fully
 *   refunded charge has status 'refunded' and a partial one
 *   'partially_refunded', never 'paid'. 21 of 22 Stripe charges were refunded
 *   and every invoice for them used to say PAID.
 */
'use strict';

const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

function paidVia(m) {
  // A recorded Stripe refund or checkout session is evidence of a Stripe
  // charge: seven April missions were charged without storing the
  // PaymentIntent id.
  if (m.latest_payment_intent_id || m.checkout_session_id || (m.stripe_refund_ids && m.stripe_refund_ids.length)) return 'stripe';
  if (m.payment_method === 'admin_override') return 'admin';
  if (m.promo_code) return 'promo';
  return 'unrecorded';
}

function buildInvoice(m) {
  const via = paidVia(m);

  // A mission run on an admin override was never charged: no card, no Stripe,
  // nothing owed. `paid_amount_cents` is null on every one of them, so the
  // fallback below billed them at their LIST price - 11 test missions carried
  // invoices totalling $849 for money nobody paid and nobody owed. An override
  // invoice is $0, and the payment note already says who provided it.
  //
  // This changes no revenue: net revenue has never counted these (they have no
  // Stripe charge, see services/payments/netRevenue.js), which is exactly why
  // the invoice must not price them either.
  const providedByVett = via === 'admin';

  const totalCents = providedByVett ? 0
    : m.paid_amount_cents != null ? Number(m.paid_amount_cents)
      : cents(m.total_price_usd) != null ? cents(m.total_price_usd)
        : 0;   // free promo, or nothing recorded (paidVia says which)

  const base = providedByVett ? 0 : (cents(m.base_cost_usd) ?? 0);
  const targeting = providedByVett ? 0 : (cents(m.targeting_surcharge_usd) ?? 0);
  const extraQuestions = providedByVett ? 0 : (cents(m.extra_questions_cost_usd) ?? 0);
  const discount = providedByVett ? 0 : (cents(m.discount_usd) ?? 0);
  const itemised = !providedByVett && m.base_cost_usd != null
    && base + targeting + extraQuestions - discount === totalCents;

  const lines = itemised
    ? { base, targetingSurcharge: targeting, extraQuestionsCost: extraQuestions, discount }
    : { base: totalCents, targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 };

  const refundedCents = Math.min(Number(m.refunded_amount_cents) || 0, totalCents);
  const netCents = totalCents - refundedCents;
  const status = refundedCents === 0 ? 'paid' : netCents === 0 ? 'refunded' : 'partially_refunded';

  const usd = (c) => Math.round(c) / 100;
  return {
    invoiceId:        `VTT-${m.id.substring(0, 8).toUpperCase()}`,
    // Named so a surface can say it plainly rather than inferring it from a
    // zero. The invoice document's payment note already reads
    // "Provided by VETT; no card payment was taken".
    providedByVett,
    missionId:        m.id,
    missionStatement: m.brief || m.title || '',
    goalType:         m.goal_type || null,
    respondentCount:  m.respondent_count,
    date:             m.paid_at,
    status,
    paidVia:          via,
    promoCode:        m.promo_code || null,
    itemised,
    lines: {
      base:               usd(lines.base),
      targetingSurcharge: usd(lines.targetingSurcharge),
      extraQuestionsCost: usd(lines.extraQuestionsCost),
      discount:           usd(lines.discount),
    },
    total:    usd(totalCents),      // charged
    refunded: usd(refundedCents),
    net:      usd(netCents),        // kept by VETT after refunds
    amount:   usd(totalCents),      // kept for older clients
  };
}

const INVOICE_COLUMNS = 'id, title, brief, goal_type, status, respondent_count, paid_at, total_price_usd, base_cost_usd, targeting_surcharge_usd, extra_questions_cost_usd, discount_usd, promo_code, paid_amount_cents, payment_method, latest_payment_intent_id, checkout_session_id, refunded_amount_cents, stripe_refund_ids';

module.exports = { buildInvoice, paidVia, INVOICE_COLUMNS };
