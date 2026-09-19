/**
 * Record Stripe refunds on the mission they belong to.
 *
 * WHY
 * ---
 * Nothing recorded a refund. The webhook endpoint was not subscribed to refund
 * events, and the handler's charge.refunded case only logged. By 2026-09-15,
 * 14 of the 15 Stripe charges VETT had ever taken were refunded in full, and
 * the database showed all 14 as kept: invoices said PAID and every revenue
 * figure summed money that had gone back to the card.
 *
 * HOW
 * ---
 * Stripe is the source of truth, and the values written are ABSOLUTE, read
 * fresh from Stripe every time, never incremented from an event payload:
 *   refunded_amount_cents = the charge's amount_refunded (succeeded + pending
 *                           refunds; canceled or failed refunds drop out)
 *   stripe_refund_ids     = the ids of the refunds that count
 * So the same event delivered twice, events out of order, a refund voided
 * later, and the backfill script all converge on the same row, and a forged
 * webhook payload cannot set an amount.
 *
 * planRefundSync is the one decision, shared by the webhook and
 * scripts/backfill-stripe-refunds.js, so the dry run cannot drift from the
 * real run.
 */
'use strict';

const COUNTED_STATUSES = new Set(['succeeded', 'pending']);

/**
 * Every succeeded Stripe PaymentIntent that paid for this mission. The stored
 * latest_payment_intent_id is not enough: seven early missions (April 2026)
 * were charged through Stripe with metadata.missionId but never stored the
 * PaymentIntent id, and all seven were refunded in full without a trace.
 */
async function missionPaymentIntents(stripe, mission) {
  const ids = new Set();
  if (mission.latest_payment_intent_id) ids.add(mission.latest_payment_intent_id);
  const found = await stripe.paymentIntents.search({ query: `metadata['missionId']:'${mission.id}' AND status:'succeeded'`, limit: 20 });
  for (const pi of found.data) ids.add(pi.id);
  return [...ids].sort();
}

/** Read the refund state of a mission from Stripe, across all of its payments. */
async function readMissionStripeState(stripe, mission) {
  const piIds = await missionPaymentIntents(stripe, mission);
  // A payment the webhook refused (it did not cover the mission as changed
  // after checkout) was refunded in full and never paid for this mission.
  const rejected = new Set(mission.rejected_payment_intent_ids || []);
  const state = { paymentIntentIds: [], chargeIds: [], capturedCents: 0, refundedCents: 0, refundIds: [] };
  for (const id of piIds) {
    if (rejected.has(id)) continue;
    const pi = await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
    if (pi.status !== 'succeeded') continue;
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    const refunds = await stripe.refunds.list({ payment_intent: id, limit: 100 });
    const counted = refunds.data.filter((r) => COUNTED_STATUSES.has(r.status));
    state.paymentIntentIds.push(id);
    if (charge) state.chargeIds.push(charge.id);
    state.capturedCents += Number(pi.amount_received) || 0;
    state.refundedCents += charge ? Number(charge.amount_refunded) || 0 : counted.reduce((sum, r) => sum + r.amount, 0);
    state.refundIds.push(...counted.map((r) => r.id));
  }
  state.refundIds.sort();
  return state;
}

/** What the mission row should become, and whether that is a change. */
function planRefundSync(mission, stripeState) {
  const nextIds = [...stripeState.refundIds].sort();
  const currentIds = [...(mission.stripe_refund_ids || [])].sort();
  const changed = Number(mission.refunded_amount_cents || 0) !== stripeState.refundedCents
    || nextIds.join(',') !== currentIds.join(',');
  return {
    missionId: mission.id,
    chargeIds: stripeState.chargeIds,
    capturedCents: stripeState.capturedCents,
    refundedCents: stripeState.refundedCents,
    recordedCents: Number(mission.refunded_amount_cents || 0),
    legacyPartialRefundCents: mission.partial_refund_amount_cents ?? null,
    netCents: stripeState.capturedCents - stripeState.refundedCents,
    changed,
    patch: changed
      ? { refunded_amount_cents: stripeState.refundedCents, stripe_refund_ids: nextIds, refunds_synced_at: new Date().toISOString() }
      : null,
  };
}

const MISSION_COLUMNS = 'id, paid_at, paid_amount_cents, refunded_amount_cents, stripe_refund_ids, partial_refund_amount_cents, latest_payment_intent_id, rejected_payment_intent_ids';

/** The mission a PaymentIntent paid for: the stored id first, then its metadata. */
async function findMissionForPaymentIntent({ stripe, supabase, paymentIntentId }) {
  const { data: byPi, error } = await supabase.from('missions').select(MISSION_COLUMNS)
    .eq('latest_payment_intent_id', paymentIntentId).maybeSingle();
  if (error) throw error;
  if (byPi) return byPi;
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const missionId = pi.metadata && pi.metadata.missionId;
  if (!missionId) return null;
  const { data: byMeta, error: e2 } = await supabase.from('missions').select(MISSION_COLUMNS).eq('id', missionId).maybeSingle();
  if (e2) throw e2;
  return byMeta;
}

/**
 * Sync the refunds of the mission a PaymentIntent paid for. A PaymentIntent
 * with no mission (a chat overage pack, a Stripe payment link) is reported,
 * not an error.
 */
async function syncMissionRefunds({ stripe, supabase, updateMission, logger, paymentIntentId, apply = true }) {
  const mission = await findMissionForPaymentIntent({ stripe, supabase, paymentIntentId });
  if (!mission) return { matched: false, paymentIntentId };
  // An unpaid mission has no payment for a refund to reduce: a refund on it is
  // one the webhook issued for a refused payment. Recording it would breach
  // missions_refunds_only_after_payment and make Stripe retry forever.
  if (!mission.paid_at) return { matched: true, written: false, reason: 'unpaid_mission' };
  const plan = planRefundSync(mission, await readMissionStripeState(stripe, mission));
  if (!apply || !plan.changed) return { matched: true, written: false, plan };
  const { error: writeErr } = await updateMission(supabase, mission.id, plan.patch, { caller: 'stripe refund sync', strict: true });
  if (writeErr) throw writeErr;
  logger?.info?.('Mission refunds synced from Stripe', { missionId: mission.id, refundedCents: plan.refundedCents, netCents: plan.netCents });
  return { matched: true, written: true, plan };
}

module.exports = { missionPaymentIntents, readMissionStripeState, planRefundSync, findMissionForPaymentIntent, syncMissionRefunds, MISSION_COLUMNS };
