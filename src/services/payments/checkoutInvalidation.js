/**
 * A checkout session must not outlive the price it was made for.
 *
 * Customers edit their mission from the browser while it is unpaid. A Stripe
 * Checkout session is priced once, when it is created, and stays payable for
 * an hour. On 2026-09-18 a session was created for $9 at 5 respondents and the
 * mission then read 1,250. The run guard (paymentCoversRun) would have refused
 * to run it after payment - a customer who paid and got nothing.
 *
 * Three lines of defence, in order:
 *   1. The database (migrations/pass-60): a price-relevant edit to a mission
 *      with an open session moves that session to superseded_checkout_session_ids
 *      and puts the mission back to draft, so the next Pay prices it afresh.
 *   2. expireSupersededSessions(): superseded (and replaced) sessions are
 *      expired in Stripe so they cannot be paid. Runs when a new checkout is
 *      created and from the recovery cron.
 *   3. guardPaymentCoversMission(): before the webhook marks a mission paid,
 *      the payment must cover the mission AS IT NOW IS. If it does not, it is
 *      refunded in full, recorded in rejected_payment_intent_ids (so it never
 *      counts as revenue), an admin is alerted and the customer is told.
 *
 * The run guard stays as the last line.
 */
'use strict';

const logger = require('../../utils/logger');

const usd = (cents) => {
  const d = Number(cents || 0) / 100;
  return `$${d.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(d) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

/**
 * Expire the given sessions in Stripe if they are still open.
 * @returns {Promise<{expired: string[], settled: string[], failed: string[]}>}
 *   settled = already expired or complete (nothing to do)
 */
async function expireSessions(stripe, sessionIds) {
  const out = { expired: [], settled: [], failed: [] };
  for (const id of [...new Set((sessionIds || []).filter(Boolean))]) {
    try {
      const s = await stripe.checkout.sessions.retrieve(id);
      if (s.status === 'open') {
        await stripe.checkout.sessions.expire(id);
        out.expired.push(id);
      } else {
        out.settled.push(id);
      }
    } catch (err) {
      logger.warn('checkout session expiry failed', { sessionId: id, err: err.message });
      out.failed.push(id);
    }
  }
  return out;
}

/**
 * Expire every superseded session still listed on any mission, and drop the
 * ones that are no longer payable from the list. Idempotent.
 */
async function expireSupersededSessions({ stripe, supabase }) {
  const { data: rows, error } = await supabase
    .from('missions')
    .select('id, superseded_checkout_session_ids')
    .neq('superseded_checkout_session_ids', '{}');
  if (error) throw error;
  const summary = { missions: 0, expired: 0, settled: 0, failed: 0 };
  for (const m of rows || []) {
    const ids = m.superseded_checkout_session_ids || [];
    if (!ids.length) continue;
    summary.missions += 1;
    const r = await expireSessions(stripe, ids);
    summary.expired += r.expired.length;
    summary.settled += r.settled.length;
    summary.failed += r.failed.length;
    const done = new Set([...r.expired, ...r.settled]);
    const remaining = ids.filter((id) => !done.has(id));
    if (remaining.length !== ids.length) {
      const { error: upErr } = await supabase.from('missions')
        .update({ superseded_checkout_session_ids: remaining }).eq('id', m.id);
      if (upErr) logger.warn('superseded session list update failed', { missionId: m.id, err: upErr.message });
    }
  }
  if (summary.missions) logger.info('Superseded checkout sessions processed', summary);
  return summary;
}

/**
 * Called by the payment webhook BEFORE a mission is marked paid.
 *
 * @returns {Promise<{accepted: boolean, reason: string, coverage?: object}>}
 *   accepted=false means the payment was refunded and the mission left unpaid.
 */
async function guardPaymentCoversMission({ stripe, supabase, pi, checkPaymentCoversRun, email }) {
  const missionId = pi && pi.metadata && pi.metadata.missionId;
  if (!missionId) return { accepted: true, reason: 'not_a_mission_payment' };

  const { data: mission, error } = await supabase.from('missions').select('*').eq('id', missionId).maybeSingle();
  if (error || !mission) return { accepted: true, reason: 'mission_not_found' };
  // Already paid by this or another event: the existing duplicate and stale
  // guards in the webhook handle those. Only an unpaid mission is judged here.
  if (!['draft', 'pending_payment'].includes(mission.status)) return { accepted: true, reason: 'already_past_payment' };
  if ((mission.rejected_payment_intent_ids || []).includes(pi.id)) return { accepted: false, reason: 'already_rejected' };

  const coverage = await checkPaymentCoversRun(supabase, { ...mission, latest_payment_intent_id: pi.id });
  if (coverage.ok) return { accepted: true, reason: 'covers', coverage };
  // Stripe could not be read: do not refund on a guess. The run guard will
  // re-check before any work is done.
  if (coverage.unverifiable) return { accepted: true, reason: 'unverifiable', coverage };

  // The payment does not cover the mission as it now stands. Refund it.
  await stripe.refunds.create(
    { payment_intent: pi.id, reason: 'requested_by_customer', metadata: { vett_reason: 'mission_changed_after_checkout', mission_id: missionId } },
    { idempotencyKey: `uncovered-payment-${pi.id}` },
  );

  const { error: upErr } = await supabase.from('missions').update({
    rejected_payment_intent_ids: [...(mission.rejected_payment_intent_ids || []), pi.id],
    status: 'draft',
    checkout_session_id: null,
  }).eq('id', missionId);
  if (upErr) logger.error('rejected payment could not be recorded on the mission', { missionId, pi: pi.id, err: upErr.message });

  const paidUsd = usd(coverage.capturedCents);
  const owedUsd = usd(coverage.owedCents);
  await supabase.from('admin_alerts').insert({
    alert_type: 'payment_refunded_mission_changed',
    mission_id: missionId,
    user_id: mission.user_id || null,
    payload: {
      payment_intent_id: pi.id,
      paid_cents: coverage.capturedCents,
      owed_cents: coverage.owedCents,
      respondent_count: mission.respondent_count,
      action_required: 'None: the payment was refunded in full and the mission left as a draft. Check the customer was told.',
    },
    resolved: false,
  }).then(() => {}, (e) => logger.warn('admin alert insert failed', { err: e.message }));

  if (mission.user_id) {
    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type: 'payment_refunded',
      title: 'Payment refunded',
      body: `Your mission changed after checkout, so we refunded ${paidUsd} in full. Open it to pay the updated price of ${owedUsd}.`,
      link: `/dashboard/${missionId}`,
    }).then(() => {}, (e) => logger.warn('refund notification insert failed', { err: e.message }));
    try {
      const { data: { user } = {} } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user && user.email && email) {
        await email.sendPaymentRefundedMissionChangedEmail({
          to: user.email,
          name: user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name),
          missionStatement: mission.title || mission.brief || '',
          missionId,
          paidUsd,
          owedUsd,
        });
      }
    } catch (e) {
      logger.warn('refund email lookup failed', { err: e.message });
    }
  }

  logger.error('Payment did not cover the mission as it now stands: refunded', {
    missionId, pi: pi.id, paidCents: coverage.capturedCents, owedCents: coverage.owedCents,
  });
  return { accepted: false, reason: 'uncovered_refunded', coverage };
}

module.exports = { expireSessions, expireSupersededSessions, guardPaymentCoversMission };
