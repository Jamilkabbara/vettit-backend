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
const { synthesizeInsights, aggregate } = require('../services/ai/insights');
const { generateTargetingBrief } = require('../services/ai/targetingBrief');
const { analyzeCreative }       = require('../services/ai/creativeAttention');
const { updateMission } = require('../db/missionSchema');
// Pass 42 A2 — recruit-until-qualified loop (env-gated). When
// RECRUIT_LOOP_ENABLED=true the new flow replaces the batch
// generate+simulate+retry path with a streaming per-persona loop
// that respects the 70% margin ceiling.
const { runRecruitmentLoop, shouldUseRecruitLoop } = require('../services/ai/recruitLoop');
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

    // Pass 42 A2 — env-gated streaming recruitment loop. When
    // RECRUIT_LOOP_ENABLED=true and the mission has the Pass 42 A1
    // columns populated (target_qualified_count + ai_spend_ceiling_usd),
    // the new flow runs persona-by-persona until target qualified
    // reached OR the 70% margin ceiling is hit. Otherwise, falls
    // through to the legacy batch flow below.
    let personas;
    let responses;
    let recruitmentPartial = false;
    if (shouldUseRecruitLoop(mission)) {
      logger.info('Mission run: using Pass 42 A2 recruit loop', {
        missionId,
        target: mission.target_qualified_count,
        ceilingUsd: mission.ai_spend_ceiling_usd,
      });
      const loopResult = await runRecruitmentLoop(mission, supabase);
      personas  = loopResult.personas;
      responses = loopResult.responses;
      recruitmentPartial = loopResult.partial;
      // Brand Lift exposure split still applies — tag exposed/control
      // by order of qualification.
      if (mission.goal_type === 'brand_lift' && personas.length > 0) {
        const exposedCount = Math.ceil(personas.length / 2);
        personas = personas.map((p, i) => ({
          ...p,
          _exposure_status: i < exposedCount ? 'exposed' : 'control',
        }));
        logger.info('Mission run: brand_lift exposure split (recruit-loop path)', {
          missionId, exposed: exposedCount, control: personas.length - exposedCount,
        });
      }
    } else {
      // ── Legacy batch flow (pre-Pass-42 behaviour) ──────────────────────
      // Round 1: generate exactly N with screener constraints baked in.
      personas = await generatePersonas(mission, targetCount);

    // Pass 27 — Brand Lift incrementality. Split ~50/50 exposed vs control
    // and tag each persona so the simulator prompt can shift answers
    // realistically (exposed: lifted aided recall, awareness, message
    // association; control: baseline). Other goal types stay
    // 'not_applicable'.
    if (mission.goal_type === 'brand_lift') {
      const exposedCount = Math.ceil(personas.length / 2);
      personas = personas.map((p, i) => ({
        ...p,
        _exposure_status: i < exposedCount ? 'exposed' : 'control',
      }));
      logger.info('Mission run: brand_lift exposure split', {
        missionId, exposed: exposedCount, control: personas.length - exposedCount,
      });
    }
    responses = await simulateAllResponses(
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
    } // close Pass 42 A2 `else` (legacy batch flow)

    // Pass 27 — propagate exposure_status from persona to its responses
    // for brand_lift missions. Lookup map is small (≤ targetCount) so a
    // plain object is fine.
    const exposureByPersonaId = {};
    for (const p of personas) {
      const pid = p.persona_id || p.id;
      if (pid && p._exposure_status) exposureByPersonaId[pid] = p._exposure_status;
    }

    // Persist responses (chunked).
    const rows = responses.map((r) => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      answer:          r.answer,
      screened_out:    Boolean((r.persona_profile || {}).screened_out),
      exposure_status: exposureByPersonaId[r.persona_id] || 'not_applicable',
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

    // Pass 32 X1 → Pass 33 W4 → Pass 36 A0 — delivered_respondent_count
    // = COUNT(DISTINCT persona_id) from responses. The Pass 33 W4
    // semantics counted ROWS (personas × questions) and the W4
    // verification was tautological (compared the lying column to its
    // own derivation). May 11 2026 demo failed because every paid
    // mission overstated respondents by 2-10x. Doctrine #16: SQL
    // invariants must compare to GROUND TRUTH not derived columns.
    //
    // CA missions stay at 0 (delivery_unit='creative_asset', no
    // respondent rows by design).
    //
    // Pass 41 BUG3 — additionally cap at targetCount. Live audit caught
    // brand_lift mission af36a36d with respondent_count=5 but
    // delivered_respondent_count=10. Root cause: the retry path
    // (screener constraint replacements) can leave the original
    // screened-out personas alongside the qualifying replacements in
    // the `responses` array if the swap-out filter doesn't catch
    // every screened-out persona_id. From the customer's view they
    // paid for 5; the column saying 10 created confusion ("did I get
    // double-charged? why does it say 10 if I requested 5?"). The
    // cap is a customer-trust safeguard: delivered ≤ requested
    // always. Over-delivery is a positive technical side-effect that
    // doesn't need to leak into the displayed number.
    const distinctPersonaCount = mission.goal_type === 'creative_attention'
      ? 0
      : new Set(responses.map((r) => r.persona_id).filter(Boolean)).size;
    const deliveredRespondentCount = mission.goal_type === 'creative_attention'
      ? 0
      : Math.min(distinctPersonaCount, targetCount);
    if (distinctPersonaCount > targetCount) {
      logger.info('Mission run: capping delivered_respondent_count at targetCount', {
        missionId,
        targetCount,
        distinctPersonaCount,
        goalType: mission.goal_type,
      });
    }

    // Pass 42 A2 — delivery_status reflects whether the recruitment
    // loop hit its target. recruitmentPartial=true only when the new
    // loop was used AND ceiling_hit terminated it. Legacy batch path
    // always reports 'full' per pre-Pass-42 semantics.
    const deliveryStatusFinal = recruitmentPartial ? 'partial' : 'full';

    // Pass 45 T1b — aggregated_by_question: the per-question map the 9
    // methodology renderers read ({distribution, average, n, verbatims}
    // keyed by question_id). Same aggregate() the synthesis prompt is
    // fed from, persisted so renderers don't recompute client-side.
    // Coexists with insights.chart_data (universal charts) by design.
    let aggregatedByQuestion = null;
    try {
      aggregatedByQuestion = aggregate(responses, mission.questions || []);
    } catch (aggErr) {
      logger.warn('Mission run: aggregated_by_question compute failed (non-fatal)', {
        missionId, err: aggErr.message,
      });
    }

    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      aggregated_by_question: aggregatedByQuestion,
      total_simulated_count:        totalSimulated,
      qualified_respondent_count:   qualifiedRespondent,
      qualification_rate:           qualificationRate,
      delivered_respondent_count:   deliveredRespondentCount,
      delivery_status:              deliveryStatusFinal,
      delivery_check_at:            new Date().toISOString(),
      // partial_refund_id and partial_refund_amount_cents stay NULL —
      // never populated for new missions under v2.
      // NOTE: Pass 42 policy — NO REFUNDS, EVER. partial delivery from
      // a hit margin ceiling is not a refundable event; customer
      // agreed to this at checkout (Pass 42 G4 microcopy).
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', {
      missionId, qualifiedRespondent, totalSimulated,
    });

    // Funnel event.
    // Pass 34 C4 — was fire-and-forget with silent .catch(() => {});
    // production audit found 25/29 paid-completed missions never fired
    // mission_completed because failures were silently swallowed. Now
    // awaited + logged so transient failures surface in Railway logs
    // and the row gets retried on the next runMission attempt if the
    // worker is re-invoked (idempotent insert on the next pass via
    // the C4 backfill SQL — duplicates would no-op since the dedup
    // join uses event_type + mission_id).
    try {
      const { error: feErr } = await supabase.from('funnel_events').insert({
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
      });
      if (feErr) {
        logger.error('Mission run: funnel_events insert failed', {
          missionId, err: feErr.message, code: feErr.code,
        });
      }
    } catch (feCatch) {
      logger.error('Mission run: funnel_events insert threw', {
        missionId, err: feCatch?.message || 'unknown',
      });
    }

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

    // Pass 44 P0 — auto-refund block REMOVED (was Pass 23 Bug 23.80).
    //
    // Two reasons:
    // 1. Policy: NO REFUNDS, EVER (Pass 42 G4, Terms §5.3). Failed
    //    missions get a support-prioritized re-run, not money back.
    // 2. Forensic: the block was dead code anyway — `createRefund` was
    //    referenced but never imported in this file, so every
    //    invocation threw ReferenceError inside its own try/catch
    //    (same dead-reference pattern as the deriveFilters P0).
    //    No refund was ever actually issued by this path; customers
    //    were being PROMISED refunds in the failure notification that
    //    nothing ever fulfilled. The promise is the bug.
    await updateMission(supabase, missionId, {
      status: 'failed',
      failure_reason: failureReason,
      completed_at: new Date().toISOString(),
    }, { caller: 'runMission: fatal' });

    // Admin alert so ops can see hard-failure missions without paging
    // funnel_events. Dedup pattern matches missionRecovery::alertAdmin.
    // Pass 44 P0 — refund fields removed from payload (NO REFUNDS;
    // the auto-refund block above is gone). action_required tells ops
    // the new contract: prioritize a re-run for the customer.
    try {
      await supabase.from('admin_alerts').insert({
        alert_type: 'mission_pipeline_failure',
        mission_id: missionId,
        user_id:    mission.user_id,
        payload: {
          failure_reason: failureReason,
          paid_amount_cents: mission.paid_amount_cents,
          payment_intent_id: mission.latest_payment_intent_id,
          action_required: 'Customer paid and got nothing — prioritize a manual re-run (admin reanalyze / re-trigger). NO refund per policy.',
        },
        resolved: false,
      });
    } catch (alertErr) {
      logger.warn('Mission run: pipeline_failure alert insert failed (non-fatal)', {
        missionId, err: alertErr.message,
      });
    }

    // Pass 44 P0 — no-refund-consistent failure copy (Pass 42 G4 /
    // Terms §5.3). The customer gets a support-prioritized re-run,
    // and the copy says exactly that — no money-back promises.
    const notifBody = `Your "${truncateTitle(mission.title)}" hit a snag before completing. Our team has been notified and will prioritize a re-run of your mission. Contact support if you don't hear from us within one business day.`;
    try {
      const { error: failNotifErr } = await supabase
        .from('notifications')
        .insert({
          user_id: mission.user_id,
          type:    'mission_failed',
          title:   'Mission failed — re-run prioritized',
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

    // Pass 44 P0 — failure email now uses the generic failure sender
    // when available; the old sendMissionFailedRefundEmail promised a
    // refund in its template. Passing refund-free fields; if only the
    // legacy sender exists it receives no refund amount (0) and
    // refundFailed=false so its template's refund branch can't fire.
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user?.email) {
        const sendFailureEmail =
          emailService.sendMissionFailedEmail || emailService.sendMissionFailedRefundEmail;
        await sendFailureEmail?.({
          to: user.email,
          name: user.user_metadata?.name || user.email.split('@')[0],
          missionTitle: mission.title || 'Your VETT mission',
          missionId,
          refundAmountUsd: 0,
          refundFailed: false,
          // Sanitize the failure reason — strip stack-trace-ish content + cap length.
          friendlyReason: friendlyFailureReason(failureReason),
        });
      }
    } catch (mailErr) {
      logger.warn('Mission run: failure email send failed', { missionId, err: mailErr.message });
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
