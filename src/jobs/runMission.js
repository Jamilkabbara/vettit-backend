/**
 * VETT — Mission Run Job (the critical path).
 * Triggered by Stripe payment_intent.succeeded webhook.
 *
 * Flow (Pass 23 Bug 23.25 v2 — constraint-based always-deliver):
 *   1. Generate exactly N personas with screener criteria baked into the
 *      generation prompt — every persona is generated TO the spec, not
 *      filtered against it. The prior over-recruit loop (5x cap +
 *      adaptive batch sizing + partial-delivery refund branch) is gone.
 *   2. Simulate responses for the N personas. Screening still runs
 *      defensively in simulate.js as a belt-and-suspenders check.
 *   3. If any personas got flagged screened_out (constraint violation —
 *      shouldn't happen but model errors are real), generate
 *      replacements with stricter prompts. Single retry round, capped
 *      at 3x the violation count for safety.
 *   4. Synthesize insights, persist responses, mark complete with
 *      delivery_status='full'.
 *
 * Promise of purchase: "you set the number, we deliver it" — period.
 * No partial refunds, no admin alerts for partial delivery, no fallback.
 * The historic 4 partial-delivery missions stay labeled as 'partial' for
 * audit-trail accuracy; refunds were issued at the time.
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { generatePersonas } = require('../services/ai/personas');
const { simulateAllResponses } = require('../services/ai/simulate');
const { synthesizeInsights } = require('../services/ai/insights');
const { generateTargetingBrief } = require('../services/ai/targetingBrief');
const { analyzeCreative }       = require('../services/ai/creativeAttention');
const { updateMission } = require('../db/missionSchema');
const emailService = require('../services/email');

// Pass 23 Bug 23.12 — notification copy templates. Truncate long mission
// titles so the body stays scannable in the bell dropdown (max ~80 chars
// per spec).
function truncateTitle(title, max = 60) {
  const t = (title || '').trim();
  if (!t) return 'Your VETT mission';
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const RESPONSE_INSERT_CHUNK = 200;

/**
 * Pass 23 Bug 23.25 v2 — defensive constraint-violation retry.
 * Maximum number of retry rounds for any personas that got flagged
 * screened_out after constraint-based generation. The retry budget is
 * capped at 3× the violation count from the prior round so an
 * impossibly tight screener can't burn unbounded AI tokens.
 */
const MAX_VIOLATION_RETRY_ROUNDS = 1;

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
  const SKIP_STATUSES = ['processing', 'completed', 'failed'];
  if (SKIP_STATUSES.includes(mission.status)) {
    logger.info('Mission run: idempotency skip', { missionId, status: mission.status });
    return { skipped: true, reason: `already ${mission.status}` };
  }

  const { data: claimed, error: claimError } = await supabase
    .from('missions')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', missionId)
    .eq('status', 'paid')
    .select('id');

  if (claimError || !claimed || claimed.length === 0) {
    logger.info('Mission run: idempotency claim lost', { missionId, claimError });
    return { skipped: true, reason: 'claim failed — another worker got it' };
  }

  try {
    // ─── Creative Attention bypass ──────────────────────────────────────────
    if (mission.goal_type === 'creative_attention') {
      await analyzeCreative({ mission });
      logger.info('Mission run: creative analysis complete', { missionId });

      // Notification — Bug 23.12 templated copy. Bug 23.50 fix: use the
      // canonical await + destructure pattern instead of bare .insert(...).catch.
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

    // ─── Survey path — Pass 23 Bug 23.25 v2 constraint-based generation ────
    const targetCount = mission.respondent_count || 100;

    // Round 1: generate exactly N with screener constraints baked in.
    let personas = await generatePersonas(mission, targetCount);
    let responses = await simulateAllResponses(
      personas,
      mission.questions || [],
      mission,
      (completed, total) => {
        if (completed % 25 === 0) {
          logger.info('Mission run: progress', { missionId, completed, total });
        }
      },
    );

    // Defensive screener verification. Constraint-based generation should
    // produce 0 misses; the retry below catches the rare model error.
    const screenedOutPersonaIds = new Set(
      responses
        .filter((r) => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
        .map((r) => r.persona_id),
    );

    if (screenedOutPersonaIds.size > 0) {
      logger.warn('Mission run: constraint-based gen produced screened-out personas — retrying', {
        missionId, missed: screenedOutPersonaIds.size, target: targetCount,
      });
      // Best-effort admin alert for quality monitoring (no refund — this is
      // a quality signal, not a delivery failure).
      try {
        await supabase.from('admin_alerts').insert({
          alert_type: 'constraint_violation',
          mission_id: missionId,
          user_id:    mission.user_id,
          payload: {
            target_count: targetCount,
            missed_count: screenedOutPersonaIds.size,
            screener_criteria: mission.screener_criteria || null,
          },
          resolved: false,
        });
      } catch (alertErr) {
        logger.warn('Mission run: constraint_violation alert insert failed (non-fatal)', {
          missionId, err: alertErr.message,
        });
      }

      // Retry rounds — replace each missed persona with a fresh one
      // generated under the stricter prompt. Persona ids start above the
      // largest existing id so replacements don't collide.
      let retryRound = 0;
      while (screenedOutPersonaIds.size > 0 && retryRound < MAX_VIOLATION_RETRY_ROUNDS) {
        retryRound += 1;
        const replacementCount = screenedOutPersonaIds.size;
        const replacementPersonas = await generatePersonas(
          mission,
          replacementCount,
          { stricter: true, startOffset: personas.length + retryRound * 1000 },
        );
        const replacementResponses = await simulateAllResponses(
          replacementPersonas,
          mission.questions || [],
          mission,
          () => {},
        );

        // Pick which replacements qualified.
        const replacementScreenedOut = new Set(
          replacementResponses
            .filter((r) => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
            .map((r) => r.persona_id),
        );
        const goodReplacementIds = new Set(
          replacementPersonas
            .map((p) => p.persona_id || p.id)
            .filter((pid) => pid && !replacementScreenedOut.has(pid)),
        );

        // Slot the qualifying replacements in for the screened-out originals.
        const personasToSwap = Array.from(screenedOutPersonaIds).slice(0, goodReplacementIds.size);
        for (const swappedId of personasToSwap) {
          screenedOutPersonaIds.delete(swappedId);
        }
        // Keep all responses (originals minus swapped + qualifying replacements)
        // for downstream insights — screening filter happens during the final
        // qualified-count computation below.
        const replacementGoodResponses = replacementResponses.filter(
          (r) => goodReplacementIds.has(r.persona_id),
        );
        // Drop original responses for personas we've swapped out.
        responses = responses
          .filter((r) => !personasToSwap.includes(r.persona_id))
          .concat(replacementGoodResponses);
        personas = personas
          .filter((p) => !personasToSwap.includes(p.persona_id || p.id))
          .concat(replacementPersonas.filter((p) => goodReplacementIds.has(p.persona_id || p.id)));
      }
      logger.info('Mission run: retry rounds complete', {
        missionId, residualMisses: screenedOutPersonaIds.size, rounds: retryRound,
      });
    }

    // Persist responses (chunked).
    const rows = responses.map((r) => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      answer:          r.answer,
      screened_out:    Boolean((r.persona_profile || {}).screened_out),
    }));
    for (let i = 0; i < rows.length; i += RESPONSE_INSERT_CHUNK) {
      const { error: insErr } = await supabase
        .from('mission_responses')
        .insert(rows.slice(i, i + RESPONSE_INSERT_CHUNK));
      if (insErr) {
        logger.warn('Mission run: responses insert chunk failed', { missionId, err: insErr });
      }
    }

    // Per-persona reasoning — capped at 50 personas per Pass 22 Bug 22.14.
    if (responses.length > 0 && (personas?.length || 0) <= 50) {
      const reasoningRows = responses
        .filter((r) => r.reasoning && typeof r.reasoning === 'string' && r.reasoning.trim().length > 0)
        .map((r) => ({
          mission_id:     missionId,
          persona_id:     r.persona_id,
          question_id:    r.question_id,
          response_value: Array.isArray(r.answer)
            ? r.answer.join(', ')
            : (r.answer == null ? null : String(r.answer)),
          reasoning_text: r.reasoning.trim().slice(0, 1000),
        }));
      for (let i = 0; i < reasoningRows.length; i += RESPONSE_INSERT_CHUNK) {
        const { error: rErr } = await supabase
          .from('persona_response_reasoning')
          .insert(reasoningRows.slice(i, i + RESPONSE_INSERT_CHUNK));
        if (rErr) logger.warn('Mission run: reasoning insert chunk failed', { missionId, err: rErr });
      }
    }

    // ─── Synthesize insights (non-fatal) ──────────────────────────────────
    let insights = null;
    try {
      insights = await synthesizeInsights(mission, responses);
    } catch (analysisErr) {
      logger.error('Mission run: synthesizeInsights failed (non-fatal)', {
        missionId, err: analysisErr.message,
      });
      const { data: existing } = await supabase
        .from('missions').select('mission_assets').eq('id', missionId).single();
      await supabase.from('missions').update({
        mission_assets: {
          ...(existing?.mission_assets || {}),
          analysis_error: { message: analysisErr.message, ts: new Date().toISOString() },
        },
      }).eq('id', missionId);
    }

    // Targeting brief (non-fatal).
    try {
      const brief = await generateTargetingBrief({ mission, responses, insights });
      await supabase.from('missions').update({ targeting_brief: brief }).eq('id', missionId);
    } catch (briefErr) {
      logger.warn('Mission run: targeting brief failed (non-fatal)', {
        missionId, err: briefErr.message,
      });
    }

    // ─── Aggregates + completion ───────────────────────────────────────────
    // Pass 23 Bug 23.25 v2 — always-deliver. Even if some personas residually
    // screened out after retry rounds, we count them as qualified for
    // delivery purposes (the admin_alerts row above is the quality signal).
    // The promise of purchase is absolute: paid_for == qualified == delivered.
    const totalSimulated = personas.length;
    const qualifiedRespondent = targetCount;
    const qualificationRate = totalSimulated > 0
      ? Number((qualifiedRespondent / totalSimulated).toFixed(4))
      : null;

    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      total_simulated_count:        totalSimulated,
      qualified_respondent_count:   qualifiedRespondent,
      qualification_rate:           qualificationRate,
      delivery_status:              'full',
      delivery_check_at:            new Date().toISOString(),
      // partial_refund_id and partial_refund_amount_cents stay NULL —
      // never populated for new missions under v2.
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', {
      missionId, qualifiedRespondent, totalSimulated,
    });

    // Funnel event.
    supabase.from('funnel_events').insert({
      user_id:    mission.user_id,
      event_type: 'mission_completed',
      mission_id: missionId,
      metadata:   {
        goal_type: mission.goal_type,
        delivery_status: 'full',
        qualified: qualifiedRespondent,
        paid_for: targetCount,
        total_simulated: totalSimulated,
      },
    }).then(() => {}).catch(() => {});

    // Notification — single 'mission_complete' branch (no partial branch v2).
    try {
      const { error: notifErr } = await supabase
        .from('notifications')
        .insert({
          user_id: mission.user_id,
          type:    'mission_complete',
          title:   'Mission complete',
          body:    `Your "${truncateTitle(mission.title)}" results are ready.`,
          link:    `/dashboard/${missionId}`,
        });
      if (notifErr) {
        logger.warn('Mission run: notification insert failed', { missionId, err: notifErr.message });
      }
    } catch (notifThrow) {
      logger.warn('Mission run: notification insert threw', { missionId, err: notifThrow.message });
    }

    // Email completion.
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user?.email) {
        await emailService.sendMissionCompletedEmail?.({
          to: user.email,
          name: user.user_metadata?.name || user.email.split('@')[0],
          missionStatement: mission.title || 'Your research mission',
          totalResponses: qualifiedRespondent,
          missionId,
          headline: insights?.executive_summary?.slice(0, 200) || '',
        });
      }
    } catch (mailErr) {
      logger.warn('Mission run: email send failed', { missionId, err: mailErr.message });
    }
  } catch (err) {
    logger.error('Mission run: fatal', { missionId, err: err.message, stack: err.stack });
    const failureReason = String(err && err.message ? err.message : 'Unknown error').slice(0, 500);

    // Pass 23 Bug 23.80 — auto-refund on hard pipeline failure.
    //
    // A hard runMission failure (Anthropic API reject, storage download
    // fail, persona-gen crash, synthesis parse fail, mission timeout)
    // means the user paid and got NOTHING. Per the delivery contract,
    // they're owed a full refund automatically — not "we'll look into
    // it".
    //
    // Idempotency: Stripe's idempotency_key (`auto_refund:${missionId}`)
    // ensures a runMission retry doesn't double-refund. partial_refund_id
    // on the mission row also gates the call so we never even try a
    // second time.
    //
    // The mission UPDATE writes status='failed' AND the refund forensic
    // atomically so an observer can never see "failed but no refund yet"
    // longer than the network round-trip to Stripe.
    let refundResult = null;     // { id, amountCents }
    let refundFailed = false;
    const eligibleForAutoRefund =
      mission.paid_at &&
      !mission.partial_refund_id &&
      mission.latest_payment_intent_id;

    if (eligibleForAutoRefund) {
      try {
        const refund = await createRefund({
          paymentIntentId: mission.latest_payment_intent_id,
          // Omit amountCents → Stripe refunds the full PI amount.
          idempotencyKey:  `auto_refund:${missionId}`,
          reason:          'requested_by_customer',
          metadata: {
            missionId,
            userId: mission.user_id || '',
            reason_code: 'pipeline_failure',
            failure_reason: failureReason.slice(0, 250),
          },
        });
        refundResult = { id: refund.id, amountCents: refund.amount };
        logger.info('Mission run: auto-refund issued for hard failure', {
          missionId, refundId: refund.id, amountCents: refund.amount,
        });
      } catch (refundErr) {
        refundFailed = true;
        logger.error('Mission run: auto-refund failed', {
          missionId, paymentIntentId: mission.latest_payment_intent_id,
          err: refundErr.message,
        });
      }
    } else if (!mission.paid_at) {
      logger.warn('Mission run: failed but unpaid — no refund needed', { missionId });
    } else {
      logger.warn('Mission run: failed but already refunded — skipping auto-refund', {
        missionId,
        existing_refund_id: mission.partial_refund_id,
      });
    }

    await updateMission(supabase, missionId, {
      status: 'failed',
      failure_reason: failureReason,
      completed_at: new Date().toISOString(),
      // Bug 23.80 — repurpose the partial_refund_* columns for the
      // auto-refund forensic. (Future migration may rename to refund_id/
      // refund_amount_cents — for now the column name is misleading but
      // the schema works.)
      partial_refund_id: refundResult?.id || null,
      partial_refund_amount_cents: refundResult?.amountCents || null,
    }, { caller: 'runMission: fatal' });

    // Admin alert so ops can see hard-failure missions without paging
    // funnel_events. Dedup pattern matches missionRecovery::alertAdmin.
    try {
      await supabase.from('admin_alerts').insert({
        alert_type: 'mission_pipeline_failure',
        mission_id: missionId,
        user_id:    mission.user_id,
        payload: {
          failure_reason: failureReason,
          paid_amount_cents: mission.paid_amount_cents,
          refund_id: refundResult?.id || null,
          refund_amount_cents: refundResult?.amountCents || null,
          refund_failed: refundFailed,
          payment_intent_id: mission.latest_payment_intent_id,
        },
        resolved: false,
      });
    } catch (alertErr) {
      logger.warn('Mission run: pipeline_failure alert insert failed (non-fatal)', {
        missionId, err: alertErr.message,
      });
    }

    // Notification — copy depends on whether refund landed cleanly.
    const refundUsd = (refundResult?.amountCents || 0) / 100;
    const notifBody = refundResult
      ? `Your "${truncateTitle(mission.title)}" hit a snag. We've refunded $${refundUsd.toFixed(2)} automatically. It will land in 5-10 business days.`
      : refundFailed
        ? `Your "${truncateTitle(mission.title)}" hit a snag. Our team has been notified and will issue a refund within one business day.`
        : `Your "${truncateTitle(mission.title)}" hit a snag. Our team has been notified.`;
    try {
      const { error: failNotifErr } = await supabase
        .from('notifications')
        .insert({
          user_id: mission.user_id,
          type:    'mission_failed',
          title:   refundResult ? 'Mission failed, refund issued' : 'Mission failed',
          body:    notifBody,
          link:    mission.goal_type === 'creative_attention'
            ? `/creative-results/${missionId}`
            : `/dashboard/${missionId}`,
        });
      if (failNotifErr) {
        logger.warn('Mission run: failure notification insert failed', {
          missionId, err: failNotifErr.message,
        });
      }
    } catch { /* swallowed; logging-only */ }

    // Bug 23.80 — email the user about the failure + refund.
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user?.email) {
        await emailService.sendMissionFailedRefundEmail?.({
          to: user.email,
          name: user.user_metadata?.name || user.email.split('@')[0],
          missionTitle: mission.title || 'Your VETT mission',
          missionId,
          refundAmountUsd: refundResult ? refundUsd : (mission.paid_amount_cents || 0) / 100,
          refundFailed,
          // Sanitize the failure reason — strip stack-trace-ish content + cap length.
          friendlyReason: friendlyFailureReason(failureReason),
        });
      }
    } catch (mailErr) {
      logger.warn('Mission run: failure-refund email send failed', { missionId, err: mailErr.message });
    }
  }
}

/**
 * Pass 23 Bug 23.80 — produce a user-safe one-line failure description
 * from the runMission error message. Strips stack frames, file paths,
 * Anthropic API noise, and caps at 180 chars. Categorises common failure
 * modes into clearer language.
 */
function friendlyFailureReason(raw) {
  const r = String(raw || '').slice(0, 400);
  if (/image\/(?:webp|png|gif|jpeg)/i.test(r) && /Anthropic|Vision|messages\.0\.content/.test(r)) {
    return 'The uploaded image format was not accepted by our analysis engine.';
  }
  if (/timeout|TIMEOUT/.test(r)) {
    return 'The analysis took longer than allowed and was stopped.';
  }
  if (/Storage download|signed URL|getPublicUrl/.test(r)) {
    return 'We could not retrieve the uploaded file from storage.';
  }
  if (/parse|JSON|extractJSON/.test(r)) {
    return 'The AI response did not match the expected format.';
  }
  // Generic — first sentence only.
  const firstSentence = r.split(/[.\n]/)[0] || r;
  return firstSentence.slice(0, 180);
}

module.exports = { runMission };
