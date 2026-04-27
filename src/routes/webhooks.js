const express = require('express');
const router = express.Router();
const { constructWebhookEvent } = require('../services/stripe');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
const { logPaymentError, shapeStripeError } = require('../services/paymentErrors');
const emailService = require('../services/email');

/**
 * Pass 22 Bug 22.8 — Stripe webhook idempotency.
 *
 * Stripe's at-least-once delivery means the same event (event.id) can arrive
 * twice when:
 *   * The first ack to Stripe is delayed past their 30s timeout
 *   * Network blips between Stripe and our backend
 *   * Manual "Resend webhook" from the Stripe Dashboard
 *
 * Without idempotency, double delivery of payment_intent.succeeded triggers
 * runMission() twice, which (despite that job's own claim guard) means two
 * Postgres-trip "claim" attempts and double persona-generation cost in race
 * windows. Bug 22.8 closes this at the webhook entry, before any handler
 * branch fires.
 *
 * Pattern: INSERT-then-skip with a separate received_at / processed_at
 * column pair (Bug 22.8 schema migration). Three reachable states:
 *
 *   1) First delivery: INSERT succeeds → process → UPDATE processed_at.
 *   2) Retry of fully-processed event: INSERT hits 23505 unique violation;
 *      we look up processed_at; it's NOT NULL → skip with idempotent:true.
 *   3) Retry of crashed-mid-processing event: INSERT hits 23505; processed_at
 *      is NULL → reprocess (downstream handlers — runMission, mission status
 *      updates — are themselves idempotent so re-running is safe).
 */

/**
 * Pass 22 Bug 22.8 — stale-PI guard.
 *
 * Bug 22.9 stamps mission.latest_payment_intent_id on every /create-intent
 * call (resuming where possible). If a stale Stripe webhook arrives for an
 * older PI on the SAME mission (e.g. a previously-orphaned PI that finally
 * fails after the user paid via a fresh PI), we must NOT update the mission
 * state from that stale event — the new PI is the source of truth.
 *
 * Returns { stale: boolean, reason: string }. Stale events still get logged
 * (idempotency row + payment_errors for telemetry), but skip mission-state
 * mutation.
 */
async function isStaleWebhookForMission(missionId, eventPaymentIntentId) {
  if (!missionId || !eventPaymentIntentId) return { stale: false, reason: 'no_check' };
  const { data: row, error } = await supabase
    .from('missions')
    .select('latest_payment_intent_id')
    .eq('id', missionId)
    .maybeSingle();
  if (error || !row) return { stale: false, reason: 'lookup_failed' };
  // No latest_payment_intent_id recorded — accept the event (legacy missions
  // pre-dating Bug 22.9 won't have this field set).
  if (!row.latest_payment_intent_id) return { stale: false, reason: 'no_latest_pi' };
  if (row.latest_payment_intent_id === eventPaymentIntentId) {
    return { stale: false, reason: 'matches_latest' };
  }
  return {
    stale: true,
    reason: `stale:event_pi=${eventPaymentIntentId} != latest=${row.latest_payment_intent_id}`,
  };
}

/**
 * Pass 22 Bug 22.8 — claim the event_id row. Returns one of:
 *   { mode: 'fresh' }                       → first time we've seen this event
 *   { mode: 'reprocess', received_at }      → seen before but processed_at is NULL (crash recovery)
 *   { mode: 'skip', processed_at }          → already processed; respond idempotent:true
 *   { mode: 'continue_anyway', err }        → DB write failed for non-23505 reason; don't block, downstream handlers are idempotent
 */
async function claimWebhookEvent(event) {
  const { data, error } = await supabase
    .from('stripe_webhook_events')
    .insert({
      event_id:     event.id,
      event_type:   event.type,
      payload:      event.data,
      // received_at defaults to now(); processed_at left NULL by design.
    })
    .select('event_id')
    .single();

  if (!error && data) {
    return { mode: 'fresh' };
  }

  // 23505 = unique_violation on the event_id PK
  if (error && error.code === '23505') {
    const { data: existing } = await supabase
      .from('stripe_webhook_events')
      .select('processed_at, received_at')
      .eq('event_id', event.id)
      .maybeSingle();
    if (existing?.processed_at) {
      return { mode: 'skip', processed_at: existing.processed_at };
    }
    return { mode: 'reprocess', received_at: existing?.received_at };
  }

  // Other DB error — log + continue. Stripe-side handlers below are
  // idempotent (runMission's claim guard, mission state checks), and
  // dropping the webhook because of a transient DB issue would mean
  // missing a payment confirmation — worse than potentially double-running.
  logger.warn('stripe_webhook_events claim failed (non-fatal)', {
    event_id: event.id, type: event.type, err: error?.message, code: error?.code,
  });
  return { mode: 'continue_anyway', err: error };
}

/**
 * Pass 22 Bug 22.8 — mark the event row processed_at=now() once the
 * handler branch finishes its side-effects. Best-effort; failure here just
 * means a future retry would reprocess (acceptable, downstream is idempotent).
 */
async function markProcessed(eventId) {
  await supabase
    .from('stripe_webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('event_id', eventId)
    .then(() => {}, (err) => {
      logger.warn('stripe_webhook_events markProcessed failed (non-fatal)', {
        event_id: eventId, err: err?.message,
      });
    });
}

// Stripe webhooks need the raw body — this route is mounted BEFORE the JSON parser in app.js.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = constructWebhookEvent(req.body, sig);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ─── Pass 22 Bug 22.8 — idempotency claim ─────────────────────────────
  const claim = await claimWebhookEvent(event);
  if (claim.mode === 'skip') {
    logger.info('Stripe webhook idempotent skip', {
      event_id: event.id, type: event.type, processed_at: claim.processed_at,
    });
    return res.json({ received: true, idempotent: true, processed_at: claim.processed_at });
  }
  if (claim.mode === 'reprocess') {
    logger.warn('Stripe webhook reprocessing (previous attempt did not complete)', {
      event_id: event.id, type: event.type, received_at: claim.received_at,
    });
    // fall through to the switch below — same handling as a fresh event
  }
  // 'fresh' and 'continue_anyway' both fall through.

  logger.info('Stripe webhook received', { type: event.type, mode: claim.mode });

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;

      // ─ Chat overage purchase ─────────────────────────────
      if (pi.metadata?.purpose === 'chat_overage') {
        const sessionId = pi.metadata.sessionId;
        if (sessionId) {
          try {
            // Idempotent: track which PaymentIntents have been applied
            const { data: existing } = await supabase
              .from('chat_sessions').select('metadata, quota_overage_purchased')
              .eq('id', sessionId).maybeSingle();
            const granted = existing?.metadata?.granted_payment_intents || [];
            if (!granted.includes(pi.id)) {
              const bump = Number(pi.metadata.messagesGranted || 50);
              await supabase.from('chat_sessions').update({
                quota_overage_purchased: (existing?.quota_overage_purchased || 0) + bump,
                metadata: { granted_payment_intents: [...granted, pi.id] },
                updated_at: new Date().toISOString(),
              }).eq('id', sessionId);
              logger.info('Chat overage credited via webhook', { sessionId, bump });
            }
          } catch (e) {
            logger.error('Chat overage webhook credit failed', { sessionId, err: e.message });
          }
        }
        break;
      }

      // ─ Mission payment ───────────────────────────────────
      const missionId = pi.metadata?.missionId;
      if (missionId) {
        // Pass 22 Bug 22.8 — stale-PI guard. If this webhook is for an old PI
        // and the mission has already moved on to a newer PI (Bug 22.9
        // create-intent updates latest_payment_intent_id on every fresh PI),
        // skip the mission-state mutation. The event itself is still claimed
        // in stripe_webhook_events for idempotency.
        const stale = await isStaleWebhookForMission(missionId, pi.id);
        if (stale.stale) {
          logger.warn('webhook:payment_intent.succeeded — stale PI, skipping mission update', {
            missionId, pi_id: pi.id, reason: stale.reason,
          });
        } else {
          // payment_status + updated_at columns don't exist in public.missions
          // — sanitizer strips them. `status: 'paid'` is the canonical signal.
          await updateMission(supabase, missionId, {
            status: 'paid',
            paid_at: new Date().toISOString(),
          }, { caller: 'webhook:payment_intent.succeeded' });
          logger.info('Payment confirmed via webhook → triggering mission run', { missionId, amount: pi.amount });

          // Funnel event: mission_paid (server-side, authoritative)
          const { data: paidMission } = await supabase
            .from('missions').select('user_id').eq('id', missionId).maybeSingle();
          if (paidMission?.user_id) {
            supabase.from('funnel_events').insert({
              user_id:    paidMission.user_id,
              event_type: 'mission_paid',
              mission_id: missionId,
              metadata:   { amount_cents: pi.amount, source: 'stripe_webhook' },
            }).then(() => {}).catch(() => {});
          }

          // Trigger the synthetic-audience pipeline as a fire-and-forget background job.
          // Stripe wants the webhook ack in <15s, so we don't await completion.
          // This is the AUTHORITATIVE trigger — the frontend also pings
          // /api/missions/:id/generate-responses as a belt-and-suspenders
          // measure, and that endpoint is idempotent so a double-fire is safe.
          setImmediate(() => {
            runMission(missionId).catch(err => {
              logger.error('runMission failed from webhook', { missionId, err: err.message });
            });
          });
        }
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const missionId = pi.metadata?.missionId;
      const userId    = pi.metadata?.userId || null;

      // Pass 22 Bug 22.9 — log every payment_intent.payment_failed to
      // payment_errors so the admin viewer sees the authoritative Stripe
      // failure record alongside any client-side reports for the same PI.
      // Logged regardless of stale-PI status — the failure happened on a
      // real PI even if our mission has moved on, so we want the trace.
      const shaped = shapeStripeError(pi.last_payment_error || {});
      logPaymentError({
        userId,
        missionId,
        stripePaymentIntentId: pi.id,
        errorCode:             shaped.errorCode,
        errorMessage:          shaped.errorMessage,
        declineCode:           shaped.declineCode,
        paymentMethod:         shaped.paymentMethod
                                || (pi.payment_method_types && pi.payment_method_types[0])
                                || null,
        amountCents:           pi.amount,
        currency:              pi.currency || 'usd',
        stage:                 'webhook_payment_failed',
        userAgent:             null, // backend webhook has no UA
      }).catch(() => {});

      if (missionId) {
        // Pass 22 Bug 22.8 — stale-PI guard. Don't flip a mission to 'failed'
        // because of a webhook for an old PI; the user may have already paid
        // via a newer PI (Bug 22.9 create-intent resumes / mints fresh).
        const stale = await isStaleWebhookForMission(missionId, pi.id);
        if (stale.stale) {
          logger.warn('webhook:payment_intent.payment_failed — stale PI, skipping mission status flip', {
            missionId, pi_id: pi.id, reason: stale.reason,
          });
        } else {
          await updateMission(supabase, missionId, {
            status: 'failed',
          }, { caller: 'webhook:payment_intent.payment_failed' });

          // User-facing notification + email. `mission_statement` was dropped
          // from schema; use `brief` or `title` for the email copy.
          const { data: mission } = await supabase
            .from('missions').select('user_id, title, brief').eq('id', missionId).single();
          if (mission?.user_id) {
            await supabase.from('notifications').insert({
              user_id: mission.user_id,
              type:    'payment_failed',
              title:   'Payment failed',
              body:    'We could not process the payment for your mission. Please try again.',
              link:    `/missions/${missionId}`,
            }).then(()=>{}).catch(()=>{});

            try {
              const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
              const { data: profile } = await supabase
                .from('profiles').select('first_name, last_name, full_name').eq('id', mission.user_id).maybeSingle();
              const name = profile?.full_name || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
              if (user?.email) {
                await emailService.sendPaymentFailedEmail({
                  to: user.email,
                  name,
                  missionStatement: mission.brief || mission.title || '',
                  missionId,
                  reason: pi.last_payment_error?.message || '',
                });
              }
            } catch (e) { logger.warn('payment_failed email skipped', { err: e.message }); }
          }
          logger.warn('Payment failed via webhook', { missionId });
        }
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      logger.info('Charge refunded', { chargeId: charge.id, amount: charge.amount_refunded });
      break;
    }

    default:
      logger.debug('Unhandled webhook event type', { type: event.type });
  }

  // Pass 22 Bug 22.8 — mark this event_id processed. Idempotent retries
  // hereafter will hit the 23505 → skip path. Best-effort; if this update
  // fails the next retry will simply reprocess (and downstream handlers
  // are themselves idempotent).
  if (claim.mode !== 'continue_anyway') {
    await markProcessed(event.id);
  }

  res.json({ received: true });
});

module.exports = router;
