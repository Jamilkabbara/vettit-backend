/**
 * VETT — Mission Run Job (the critical path).
 * Triggered by Stripe payment_intent.succeeded webhook.
 *
 * Flow:
 *   1. Generate personas in over-recruit batches (Pass 23 Bug 23.25): keep
 *      simulating until qualified_respondent_count == respondent_count or a
 *      5x cap is hit. Each batch persists responses immediately (crash-safe).
 *   2. If cap hit before reaching the qualified target → mark mission
 *      delivery_status='partial', issue a proportional Stripe refund, raise
 *      an admin alert, send a partial-delivery email.
 *      Else → mark delivery_status='full'.
 *   3. Synthesize insights (Sonnet, single call)
 *   4. Mark mission complete + send completion notification + email
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { runOverRecruitedSurvey, MAX_OVER_RECRUIT_MULTIPLIER } = require('./overRecruit');

// Pass 23 Bug 23.12 — notification copy templates. Truncate long mission
// titles so the body stays scannable in the bell dropdown (max ~80 chars
// per spec). Ellipsis + 57-char window means the longest body is roughly
// 90 chars including the surrounding "Your "..." results are ready." copy.
function truncateTitle(title, max = 60) {
  const t = (title || '').trim();
  if (!t) return 'Your VETT mission';
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
const { synthesizeInsights } = require('../services/ai/insights');
const { generateTargetingBrief } = require('../services/ai/targetingBrief');
const { analyzeCreative }       = require('../services/ai/creativeAttention');
const { updateMission } = require('../db/missionSchema');
const { createRefund } = require('../services/stripe');
const emailService = require('../services/email');

async function runMission(missionId) {
  logger.info('Mission run: starting', { missionId });

  // 1. Fetch mission
  const { data: mission, error } = await supabase
    .from('missions')
    .select('*')
    .eq('id', missionId)
    .single();

  if (error || !mission) {
    logger.error('Mission run: not found', { missionId, error });
    return;
  }

  // ─── Idempotency guard ────────────────────────────────────────────────────
  // Both /api/payments/confirm and the payment_intent.succeeded webhook set
  // status='paid' before calling runMission(). Without this guard, a race
  // between the two paths (or two rapid webhook deliveries) would trigger
  // duplicate AI synthesis jobs, doubling cost for the same mission.
  //
  // Strategy: atomic conditional UPDATE — only succeeds if the row is still
  // in 'paid' state. Supabase/PostgREST returns the affected rows; if the
  // slice is empty, another worker claimed the mission first.
  const SKIP_STATUSES = ['processing', 'completed', 'failed'];
  if (SKIP_STATUSES.includes(mission.status)) {
    logger.info('Mission run: idempotency skip', { missionId, status: mission.status });
    return { skipped: true, reason: `already ${mission.status}` };
  }

  const { data: claimed, error: claimError } = await supabase
    .from('missions')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', missionId)
    .eq('status', 'paid')   // only claim if another worker hasn't already
    .select('id');

  if (claimError || !claimed || claimed.length === 0) {
    logger.info('Mission run: idempotency claim lost', { missionId, claimError });
    return { skipped: true, reason: 'claim failed — another worker got it' };
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {

    // 2. Creative Attention missions bypass the persona simulation pipeline —
    //    they analyze the uploaded creative with Claude vision directly.
    if (mission.goal_type === 'creative_attention') {
      await analyzeCreative({ mission });
      logger.info('Mission run: creative analysis complete', { missionId });

      // Notification — Bug 23.12 templated copy.
      // Pass 23 Bug 23.50 — supabase-js v2 returns a thenable, not a real
      // Promise, from .insert(). Calling `.catch()` directly on the
      // builder (or after `await`-ing it) throws "TypeError:
      // ...insert(...).catch is not a function" and propagates out — the
      // creative analysis itself ran fine, but this line crashed the
      // mission to status='failed' and lost the notification. Mission
      // f64eabcb was the first repro. Fix: use the canonical
      // `await + destructure` pattern so the call is a no-throw.
      try {
        const { error: notifErr } = await supabase
          .from('notifications')
          .insert({
            user_id: mission.user_id,
            type:    'mission_complete',
            title:   'Mission complete',
            body:    `Your "${truncateTitle(mission.title)}" creative analysis is ready.`,
            link:    `/creative-results/${missionId}`,
          });
        if (notifErr) {
          logger.warn('Mission run: creative_attention notification insert failed', {
            missionId, err: notifErr.message,
          });
        }
      } catch (notifThrow) {
        logger.warn('Mission run: creative_attention notification insert threw', {
          missionId, err: notifThrow.message,
        });
      }

      return;
    }

    // ─── Pass 23 Bug 23.25 — over-recruit survey loop ──────────────────────
    // Replaces the old single-shot generatePersonas + simulateAllResponses
    // with an adaptive multi-round loop that persists responses incrementally
    // and exits when qualified_count >= respondent_count OR cap is reached.
    const targetQualified = mission.respondent_count || 100;
    const {
      personas,
      responses,
      totalSimulated,
      qualifiedCount: actualQualifiedCount,
      rounds,
      capHit,
    } = await runOverRecruitedSurvey({ mission, missionId });

    logger.info('Mission run: over-recruit complete', {
      missionId, rounds, totalSimulated, actualQualifiedCount, targetQualified, capHit,
    });

    // Cap qualifiedCount at target for reporting so dashboards don't show
    // 12/10 — extras still live in mission_responses for the user's benefit.
    const qualifiedRespondent = Math.min(actualQualifiedCount, targetQualified);

    // 5. Synthesize insights (wrapped so a summary failure never blocks completion)
    // Persona responses are expensive and cannot be cheaply regenerated.
    // Summary CAN be regenerated later from stored responses, so we always
    // mark the mission completed regardless of whether analysis succeeds.
    let insights = null;
    try {
      insights = await synthesizeInsights(mission, responses);
    } catch (analysisErr) {
      logger.error('Mission run: synthesizeInsights failed (non-fatal)', {
        missionId,
        err: analysisErr.message,
        stack: analysisErr.stack,
      });
      // Store the error in mission_assets.analysis_error for later inspection/retry.
      const { data: existing } = await supabase
        .from('missions')
        .select('mission_assets')
        .eq('id', missionId)
        .single();
      await supabase.from('missions').update({
        mission_assets: {
          ...(existing?.mission_assets || {}),
          analysis_error: {
            message: analysisErr.message,
            ts: new Date().toISOString(),
          },
        },
      }).eq('id', missionId);
    }

    // 5b. Generate targeting brief (non-fatal — mission still completes without it)
    try {
      const brief = await generateTargetingBrief({
        mission,
        responses,
        insights,
      });
      await supabase.from('missions').update({ targeting_brief: brief }).eq('id', missionId);
      logger.info('Mission run: targeting brief generated', { missionId });
    } catch (briefErr) {
      logger.warn('Mission run: targeting brief failed (non-fatal)', {
        missionId,
        err: briefErr.message,
      });
    }

    // ─── Pass 23 Bug 23.25 — delivery decision + partial-refund branch ─────
    const deliveryFull = qualifiedRespondent >= targetQualified;
    const deliveryStatus = deliveryFull ? 'full' : 'partial';
    const qualificationRate = totalSimulated > 0
      ? Number((actualQualifiedCount / totalSimulated).toFixed(4))
      : null;

    // Compute the proportional refund amount (cents) for partial deliveries.
    // Source of truth is paid_amount_cents (cached from pi.amount_received at
    // PI succeed). Fallback to total_price_usd*100 if paid_amount_cents is
    // missing for any reason (legacy/orphan rows).
    let refundResult = null;  // { id, amountCents } | null
    let refundFailed = false;

    if (!deliveryFull) {
      const gap = targetQualified - qualifiedRespondent;
      const paidCents = Number.isFinite(mission.paid_amount_cents)
        ? mission.paid_amount_cents
        : Math.round(Number(mission.total_price_usd || 0) * 100);
      const refundCents = Math.floor((paidCents * gap) / targetQualified);

      logger.warn('Mission run: partial delivery — issuing refund', {
        missionId,
        targetQualified,
        actualQualifiedCount,
        qualifiedRespondent,
        gap,
        paidCents,
        refundCents,
        cap: targetQualified * MAX_OVER_RECRUIT_MULTIPLIER,
        capHit,
        rounds,
      });

      // ── Admin alert — dedup pattern matching missionRecovery::alertAdmin ──
      // Insert only if no unresolved partial_delivery alert exists for this
      // mission. Best-effort; failure to insert is logged but not fatal.
      try {
        const { data: existingAlert } = await supabase
          .from('admin_alerts')
          .select('id')
          .eq('alert_type', 'partial_delivery')
          .eq('mission_id', missionId)
          .eq('resolved', false)
          .limit(1)
          .maybeSingle();
        if (!existingAlert?.id) {
          await supabase.from('admin_alerts').insert({
            alert_type: 'partial_delivery',
            mission_id: missionId,
            user_id:    mission.user_id,
            payload: {
              paid_for: targetQualified,
              qualified: qualifiedRespondent,
              total_simulated: totalSimulated,
              gap,
              cap: targetQualified * MAX_OVER_RECRUIT_MULTIPLIER,
              cap_hit: capHit,
              paid_amount_cents: paidCents,
              proposed_refund_amount_cents: refundCents,
              rounds,
            },
            resolved: false,
          });
        }
      } catch (alertErr) {
        logger.warn('Mission run: admin_alerts partial_delivery insert failed (non-fatal)', {
          missionId, err: alertErr.message,
        });
      }

      // ── Auto-refund via Stripe — idempotent ────────────────────────────
      // Idempotency key ensures a runMission retry doesn't double-refund the
      // same gap. Stripe returns the same refund object on the second call
      // with the same key.
      if (mission.latest_payment_intent_id && refundCents > 0) {
        try {
          const refund = await createRefund({
            paymentIntentId: mission.latest_payment_intent_id,
            amountCents:     refundCents,
            idempotencyKey:  `partial_refund:${missionId}`,
            reason:          'requested_by_customer',
            metadata: {
              missionId,
              userId: mission.user_id || '',
              reason_code: 'partial_delivery',
              paid_for: String(targetQualified),
              qualified: String(qualifiedRespondent),
              gap: String(gap),
            },
          });
          refundResult = { id: refund.id, amountCents: refund.amount };
          logger.info('Mission run: partial-refund issued', {
            missionId, refundId: refund.id, amountCents: refund.amount, status: refund.status,
          });
        } catch (refundErr) {
          refundFailed = true;
          logger.error('Mission run: partial-refund failed', {
            missionId,
            paymentIntentId: mission.latest_payment_intent_id,
            err: refundErr.message,
          });
          // Surface to the admin_alerts row's payload so ops can retry manually.
          try {
            await supabase
              .from('admin_alerts')
              .update({
                payload: {
                  paid_for: targetQualified,
                  qualified: qualifiedRespondent,
                  total_simulated: totalSimulated,
                  gap,
                  cap: targetQualified * MAX_OVER_RECRUIT_MULTIPLIER,
                  cap_hit: capHit,
                  paid_amount_cents: paidCents,
                  proposed_refund_amount_cents: refundCents,
                  rounds,
                  refund_failed: true,
                  refund_error: refundErr.message,
                },
              })
              .eq('mission_id', missionId)
              .eq('alert_type', 'partial_delivery')
              .eq('resolved', false);
          } catch { /* logging is best-effort */ }
        }
      } else {
        // Can't refund — no PI on the row. Log but don't crash. Admin alert
        // already has the forensic; ops will resolve manually.
        refundFailed = true;
        logger.warn('Mission run: partial delivery without PI — manual refund required', {
          missionId,
          hasLatestPI: Boolean(mission.latest_payment_intent_id),
          refundCents,
        });
      }
    }

    // 6. Mark complete with all the Bug 23.25 forensic fields populated.
    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      total_simulated_count:        totalSimulated,
      qualified_respondent_count:   qualifiedRespondent,
      qualification_rate:           qualificationRate,
      delivery_status:              deliveryStatus,
      delivery_check_at:            new Date().toISOString(),
      partial_refund_id:            refundResult?.id || null,
      partial_refund_amount_cents:  refundResult?.amountCents || null,
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', {
      missionId, deliveryStatus, qualifiedRespondent, totalSimulated,
      refundId: refundResult?.id || null, refundFailed,
    });

    // Funnel event: mission_completed
    supabase.from('funnel_events').insert({
      user_id:    mission.user_id,
      event_type: 'mission_completed',
      mission_id: missionId,
      metadata:   {
        goal_type: mission.goal_type,
        delivery_status: deliveryStatus,
        qualified: qualifiedRespondent,
        paid_for: targetQualified,
        total_simulated: totalSimulated,
      },
    }).then(() => {}).catch(() => {});

    // 7. Notification (real-time via Supabase realtime).
    //    Pass 23 Bug 23.12 — branch on delivery decision: full → mission_complete,
    //    partial → mission_partial. Both link to /dashboard/:id (mission control)
    //    where the user can both see the report and follow up on the gap.
    if (deliveryFull) {
      await supabase.from('notifications').insert({
        user_id: mission.user_id,
        type:    'mission_complete',
        title:   'Mission complete',
        body:    `Your "${truncateTitle(mission.title)}" results are ready.`,
        link:    `/dashboard/${missionId}`,
      });
    } else {
      const gap = targetQualified - qualifiedRespondent;
      const refundDollarsForBody = refundResult?.amountCents
        ? (refundResult.amountCents / 100).toFixed(2)
        : (((mission.paid_amount_cents
            || Math.round(Number(mission.total_price_usd || 0) * 100))
          * gap / targetQualified) / 100).toFixed(2);
      await supabase.from('notifications').insert({
        user_id: mission.user_id,
        type:    'mission_partial',
        title:   'Mission delivered partially',
        body:    `Your "${truncateTitle(mission.title)}" delivered ${qualifiedRespondent} of ${targetQualified} qualified respondents. We refunded $${refundDollarsForBody}.`,
        link:    `/dashboard/${missionId}`,
      });
    }

    // 8. Email — completion or partial-delivery (best-effort).
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user?.email) {
        if (!deliveryFull) {
          const refundUsd = (refundResult?.amountCents || 0) / 100;
          const proposedRefundUsd = ((mission.paid_amount_cents
            || Math.round(Number(mission.total_price_usd || 0) * 100))
            * (targetQualified - qualifiedRespondent)
            / targetQualified) / 100;
          await emailService.sendPartialDeliveryEmail?.({
            to: user.email,
            name: user.user_metadata?.name || user.email.split('@')[0],
            missionTitle: mission.title || 'Your VETT mission',
            missionId,
            paidFor: targetQualified,
            qualified: qualifiedRespondent,
            refundAmountUsd: refundResult ? refundUsd : proposedRefundUsd,
            refundFailed,
          });
        } else {
          // Note: the legacy call site used 'sendMissionCompleteEmail' (no
          // 'd'), which silently no-op'd via optional chaining — completion
          // emails never actually went out. Pass 23 Bug 23.25 fixes both the
          // name and the arg shape so users actually get the email when
          // their full-delivery mission completes.
          await emailService.sendMissionCompletedEmail?.({
            to: user.email,
            name: user.user_metadata?.name || user.email.split('@')[0],
            missionStatement: mission.title || 'Your research mission',
            totalResponses: qualifiedRespondent,
            missionId,
            headline: insights?.executive_summary?.slice(0, 200) || '',
          });
        }
      }
    } catch (mailErr) {
      logger.warn('Mission run: email send failed', { missionId, err: mailErr.message });
    }
  } catch (err) {
    logger.error('Mission run: fatal', { missionId, err: err.message, stack: err.stack });
    // Pass 21 Bug 19 — persist the actual reason. Truncate to a generous but
    // bounded length so a freak megabyte stack trace doesn't bloat the row.
    // The /results endpoint surfaces this verbatim to the user, so prefer
    // err.message (already user-shaped) over err.stack.
    const failureReason = String(err && err.message ? err.message : 'Unknown error').slice(0, 500);
    await updateMission(supabase, missionId, {
      status: 'failed',
      failure_reason: failureReason,
      completed_at: new Date().toISOString(),
    }, { caller: 'runMission: fatal' });

    // Pass 23 Bug 23.12 — templated copy + link to /dashboard/:id (mission
    // control) where the user can see the failure context, not /results
    // which would render an empty report.
    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_failed',
      title:   'Mission failed',
      body:    `Your "${truncateTitle(mission.title)}" encountered an error and was refunded. Our team has been notified.`,
      link:    `/dashboard/${missionId}`,
    }).then(() => {}).catch(() => {});
  }
}

module.exports = { runMission };
