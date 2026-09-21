/**
 * A chat top-up is money, so it gets a row.
 *
 * A top-up buys +50 chat messages for $5. The webhook credited the messages to
 * the chat session and recorded the PaymentIntent in that session's metadata,
 * which made the CREDIT idempotent. It recorded the MONEY nowhere: revenue,
 * invoices and the admin dashboard are computed from `missions`, and a top-up
 * has no mission. A paid top-up was invisible to every business figure.
 *
 * Audited before this was written (2026-09-21): zero top-ups have ever been
 * bought, so nothing was lost and there is nothing to backfill. This records
 * the first one that is.
 *
 * Idempotency is the same shape as refunds: the Stripe PaymentIntent id is
 * unique on the table, amounts are always read from Stripe rather than taken
 * from the event body, and recording twice changes nothing. A replayed,
 * reordered or forged event cannot invent revenue.
 */
'use strict';

const CHAT_TOPUP_COLUMNS = 'id, user_id, chat_session_id, stripe_payment_intent_id, stripe_checkout_session_id, amount_cents, currency, messages_granted, refunded_amount_cents, stripe_refund_ids, refunds_synced_at, paid_at';

/** Net is what VETT kept: charged minus refunded, never below zero. */
function topupNetRevenueCents(t) {
  const gross = Math.max(Number(t && t.amount_cents) || 0, 0);
  return Math.max(gross - (Number(t && t.refunded_amount_cents) || 0), 0);
}

const sumTopupNetUsd = (rows) => (rows || []).reduce((s, t) => s + topupNetRevenueCents(t), 0) / 100;

/**
 * Record a successful top-up payment.
 *
 * The amount comes from the PaymentIntent Stripe hands us, never from
 * metadata: metadata is set by us at checkout and a forged event could carry
 * anything. Inserting is conditional on the unique PaymentIntent id, so a
 * redelivered event is a no-op rather than a second $5 of revenue.
 *
 * @returns {Promise<{recorded: boolean, reason: string, id?: string}>}
 */
async function recordChatTopup({ supabase, pi, logger }) {
  if (!pi || !pi.id) return { recorded: false, reason: 'no_payment_intent' };
  const meta = pi.metadata || {};
  if (meta.purpose !== 'chat_overage') return { recorded: false, reason: 'not_a_topup' };

  const amountCents = Number(pi.amount_received);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { recorded: false, reason: 'no_amount_captured' };
  }

  const row = {
    user_id: meta.userId || null,
    chat_session_id: meta.sessionId || null,
    stripe_payment_intent_id: pi.id,
    stripe_checkout_session_id: meta.checkoutSessionId || null,
    amount_cents: amountCents,
    currency: pi.currency || 'usd',
    messages_granted: Number(meta.messagesGranted) || 50,
    paid_at: new Date((pi.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  if (!row.user_id) {
    // Without an owner the row cannot satisfy the not-null user, and the
    // customer could not see the invoice. Say so rather than drop it quietly.
    if (logger) logger.error('Chat top-up paid but no userId in its metadata; not recorded', { paymentIntentId: pi.id });
    return { recorded: false, reason: 'no_user_id' };
  }

  const { data, error } = await supabase
    .from('chat_topups')
    .upsert(row, { onConflict: 'stripe_payment_intent_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  const inserted = Array.isArray(data) && data.length > 0;
  if (logger) {
    logger.info(inserted ? 'Chat top-up recorded' : 'Chat top-up already recorded (idempotent no-op)', {
      paymentIntentId: pi.id, amountCents, userId: row.user_id,
    });
  }
  return { recorded: inserted, reason: inserted ? 'recorded' : 'already_recorded', id: inserted ? data[0].id : undefined };
}

/**
 * Bring a top-up's refunds in line with Stripe, for one PaymentIntent.
 *
 * Amounts are read from Stripe, exactly as syncMissionRefunds does, so a
 * cancelled or failed refund lowers the figure again rather than leaving the
 * first number in place.
 *
 * @returns {Promise<{matched: boolean, written: boolean, refundedCents?: number}>}
 */
async function syncChatTopupRefunds({ stripe, supabase, paymentIntentId, logger, apply = true }) {
  if (!paymentIntentId) return { matched: false, written: false };
  const { data: topup, error } = await supabase
    .from('chat_topups').select(CHAT_TOPUP_COLUMNS)
    .eq('stripe_payment_intent_id', paymentIntentId).maybeSingle();
  if (error) throw error;
  if (!topup) return { matched: false, written: false };

  const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
  const counted = (refunds.data || []).filter((r) => r.status === 'succeeded' || r.status === 'pending');
  const refundedCents = counted.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const refundIds = counted.map((r) => r.id).sort();

  const same = refundedCents === Number(topup.refunded_amount_cents || 0)
    && JSON.stringify(refundIds) === JSON.stringify([...(topup.stripe_refund_ids || [])].sort());
  if (same) return { matched: true, written: false, refundedCents };
  if (!apply) return { matched: true, written: false, refundedCents, wouldWrite: true };

  const { error: upErr } = await supabase.from('chat_topups').update({
    refunded_amount_cents: Math.min(refundedCents, Number(topup.amount_cents) || 0),
    stripe_refund_ids: refundIds,
    refunds_synced_at: new Date().toISOString(),
  }).eq('id', topup.id);
  if (upErr) throw upErr;
  if (logger) logger.info('Chat top-up refunds synced', { paymentIntentId, refundedCents });
  return { matched: true, written: true, refundedCents };
}

/**
 * The customer-facing invoice for a top-up. Same shape as a mission invoice so
 * the invoices list can render both without knowing which is which.
 */
function buildTopupInvoice(t) {
  const usd = (c) => Math.round(c) / 100;
  const total = Math.max(Number(t.amount_cents) || 0, 0);
  const refunded = Math.min(Number(t.refunded_amount_cents) || 0, total);
  const net = total - refunded;
  return {
    invoiceId: `VTT-CHAT-${String(t.id).substring(0, 8).toUpperCase()}`,
    missionId: null,
    kind: 'chat_topup',
    missionStatement: `Chat top-up: ${t.messages_granted} extra messages`,
    goalType: null,
    respondentCount: null,
    date: t.paid_at,
    status: refunded === 0 ? 'paid' : net === 0 ? 'refunded' : 'partially_refunded',
    paidVia: 'stripe',
    promoCode: null,
    itemised: false,
    lines: { base: usd(total), targetingSurcharge: 0, extraQuestionsCost: 0, discount: 0 },
    total: usd(total),
    refunded: usd(refunded),
    net: usd(net),
    amount: usd(total),
  };
}

module.exports = {
  CHAT_TOPUP_COLUMNS,
  topupNetRevenueCents,
  sumTopupNetUsd,
  recordChatTopup,
  syncChatTopupRefunds,
  buildTopupInvoice,
};
