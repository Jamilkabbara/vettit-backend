/**
 * VETT — Mission Run Job (the critical path).
 * Triggered by Stripe payment_intent.succeeded webhook.
 *
 * Flow:
 *   1. Generate N personas (Haiku, batched 10x, concurrency 5)
 *   2. Simulate responses per persona (Haiku, concurrency 8)
 *   3. Synthesize insights (Sonnet, single call)
 *   4. Mark mission complete + send notification + email
 *
 * Pass 19 — Task 0: Guaranteed Qualified Delivery
 *   If the mission has a screening question, we oversample personas until we
 *   have enough qualified respondents (or until we hit 3x the ordered count).
 *   Delivery metrics (qualified_respondent_count, total_simulated_count,
 *   qualification_rate, delivery_status) are written to the missions row so
 *   the Results page and Admin panel can surface them.
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

// Maximum oversample multiplier: we'll generate at most 3× the ordered count
// before giving up and delivering whatever qualified respondents we have.
const MAX_OVERSAMPLE_MULTIPLIER = 3;

// If the observed qualification rate falls below this threshold we declare
// the screener "too restrictive" rather than just "partial".
const SCREENER_TOO_RESTRICTIVE_RATE = 0.25;

/**
 * Determine whether a persona's response set indicates they passed the
 * screening question. Mirrors the logic in simulate.js / passesScreening().
 */
function wasScreenedOut(personaResponses) {
  return personaResponses.some(r => {
    const fromColumn  = r.screened_out === true;
    const fromProfile = Boolean((r.persona_profile || {}).screened_out);
    return fromColumn || fromProfile;
  });
}

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

      // Notification
      await supabase.from('notifications').insert({
        user_id: mission.user_id,
        type:    'mission_complete',
        title:   `${mission.title || 'Creative analysis'} is ready`,
        body:    'Your creative attention analysis is complete.',
        link:    `/creative-results/${missionId}`,
      }).catch(() => {});

      return;
    }

    // ── Pass 19 Task 0: Guaranteed Qualified Delivery ──────────────────────
    const questions = mission.questions || [];
    const hasScreeningQ = questions.some(q => q.isScreening);
    const orderedCount = mission.respondent_count || 100;
    const maxTotal = orderedCount * MAX_OVERSAMPLE_MULTIPLIER;

    let allResponses = [];          // every simulated response row (all personas)
    let qualifiedResponses = [];    // responses belonging to non-screened personas
    let totalSimulated = 0;         // total personas simulated so far
    let personaIdOffset = 0;        // prevent persona ID collisions across batches

    if (!hasScreeningQ) {
      // No screener — simple path: generate exactly orderedCount personas once.
      const personas = await generatePersonas(mission, orderedCount);
      logger.info('Mission run: personas generated (no screener)', { missionId, count: personas.length });
      totalSimulated = personas.length;

      allResponses = await simulateAllResponses(
        personas,
        questions,
        mission,
        (completed, total) => {
          if (completed % 25 === 0) logger.info('Mission run: progress', { missionId, completed, total });
        }
      );
      qualifiedResponses = allResponses;  // no screening → all qualify

    } else {
      // Screener present — oversample loop.
      // Build a map of personaId → screened_out so we can deduplicate without
      // re-scanning every response on every iteration.
      const personaOutcomes = new Map(); // personaId → true (screened out) | false (qualified)

      while (
        qualifiedResponses.length < orderedCount &&
        totalSimulated < maxTotal
      ) {
        // How many MORE do we need?
        const stillNeeded = orderedCount - qualifiedResponses.length;

        // Estimate batch size based on observed qualification rate (or 2× needed
        // if we have no data yet).  Always request at least stillNeeded.
        let batchSize;
        if (totalSimulated === 0) {
          batchSize = Math.ceil(stillNeeded * 2);  // cold start: assume 50% pass rate
        } else {
          const obsRate = qualifiedResponses.length / totalSimulated;
          const safeRate = Math.max(obsRate, 0.05); // never divide by <5%
          batchSize = Math.ceil(stillNeeded / safeRate);
        }

        // Cap so we don't overshoot the 3× ceiling in one shot
        const remainingBudget = maxTotal - totalSimulated;
        batchSize = Math.min(batchSize, remainingBudget, 500); // hard cap at 500/batch

        if (batchSize <= 0) break;

        logger.info('Mission run: oversampling batch', {
          missionId,
          batchSize,
          qualifiedSoFar: qualifiedResponses.length,
          totalSimulatedSoFar: totalSimulated,
          target: orderedCount,
        });

        const personas = await generatePersonas(mission, batchSize, personaIdOffset);
        personaIdOffset += batchSize;
        totalSimulated += personas.length;

        const batchResponses = await simulateAllResponses(
          personas,
          questions,
          mission,
          (completed, total) => {
            if (completed % 25 === 0) logger.info('Mission run: batch progress', { missionId, completed, total });
          }
        );

        allResponses = allResponses.concat(batchResponses);

        // Determine which personas in this batch qualified.
        // Group responses by persona_id to call wasScreenedOut per persona.
        const byPersona = new Map();
        for (const r of batchResponses) {
          if (!byPersona.has(r.persona_id)) byPersona.set(r.persona_id, []);
          byPersona.get(r.persona_id).push(r);
        }

        for (const [pId, pResponses] of byPersona) {
          const screenedOut = wasScreenedOut(pResponses);
          personaOutcomes.set(pId, screenedOut);
        }

        // Rebuild qualified list from scratch (cleaner than incremental append)
        qualifiedResponses = allResponses.filter(r => {
          const out = personaOutcomes.get(r.persona_id);
          return out === false; // explicitly NOT screened out
        });

        logger.info('Mission run: oversampling iteration complete', {
          missionId,
          qualified: qualifiedResponses.length,
          total: totalSimulated,
          rate: totalSimulated > 0 ? (qualifiedResponses.length / totalSimulated).toFixed(3) : '—',
        });
      }

      logger.info('Mission run: oversampling loop done', {
        missionId,
        qualifiedFinal: qualifiedResponses.length,
        totalSimulated,
        ordered: orderedCount,
      });
    }
    // ── End oversampling loop ──────────────────────────────────────────────

    // Compute delivery metrics
    const qualifiedCount = qualifiedResponses.length;
    const qualRate = totalSimulated > 0
      ? Number((qualifiedCount / totalSimulated).toFixed(4))
      : 1;

    let deliveryStatus;
    if (qualifiedCount >= orderedCount) {
      deliveryStatus = 'full';
    } else if (hasScreeningQ && qualRate < SCREENER_TOO_RESTRICTIVE_RATE) {
      deliveryStatus = 'screener_too_restrictive';
    } else {
      deliveryStatus = 'partial';
    }

    logger.info('Mission run: delivery metrics', {
      missionId,
      qualifiedCount,
      totalSimulated,
      qualRate,
      deliveryStatus,
    });

    // Trim allResponses: we expose ALL screener responses (for honest funnel
    // data) but cap non-screener responses to orderedCount qualified personas.
    // Build the set of persona IDs that are within the delivery cap.
    let responsesToInsert;
    if (!hasScreeningQ) {
      responsesToInsert = allResponses.slice(0, orderedCount * questions.length + 1000);
    } else {
      // Collect the first orderedCount qualified persona IDs (preserve order)
      const qualifiedPersonaIds = new Set();
      for (const r of qualifiedResponses) {
        qualifiedPersonaIds.add(r.persona_id);
        if (qualifiedPersonaIds.size >= orderedCount) break;
      }

      responsesToInsert = allResponses.filter(r => {
        // Always include screener responses for all personas (funnel data)
        const q = questions.find(q2 => q2.id === r.question_id);
        if (q && q.isScreening) return true;
        // For non-screener questions only include capped qualified personas
        return qualifiedPersonaIds.has(r.persona_id);
      });
    }

    // 4. Bulk insert responses (in chunks to stay under PostgREST limits)
    const CHUNK = 200;
    const rows = responsesToInsert.map(r => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      answer:          r.answer,
      // Bug 1/2 fix: persist screened_out as first-class column so
      // aggregation can filter without parsing JSONB on every query.
      screened_out:    Boolean((r.persona_profile || {}).screened_out),
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: insErr } = await supabase
        .from('mission_responses')
        .insert(rows.slice(i, i + CHUNK));
      if (insErr) logger.warn('Mission run: responses insert chunk failed', { missionId, err: insErr });
    }

    logger.info('Mission run: responses inserted', { missionId, count: rows.length });

    // 5. Synthesize insights (wrapped so a summary failure never blocks completion)
    // Persona responses are expensive and cannot be cheaply regenerated.
    // Summary CAN be regenerated later from stored responses, so we always
    // mark the mission completed regardless of whether analysis succeeds.
    let insights = null;
    try {
      insights = await synthesizeInsights(mission, responsesToInsert);
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
        responses: responsesToInsert,
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

    // 6. Mark complete — always, regardless of summary outcome
    // Write delivery metrics at the same time.
    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      qualified_respondent_count: qualifiedCount,
      total_simulated_count: totalSimulated,
      qualification_rate: qualRate,
      delivery_status: deliveryStatus,
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', { missionId, deliveryStatus });

    // Funnel event: mission_completed
    supabase.from('funnel_events').insert({
      user_id:    mission.user_id,
      event_name: 'mission_completed',
      properties: { mission_id: missionId, goal_type: mission.goal_type, delivery_status: deliveryStatus },
    }).then(() => {}).catch(() => {});

    // 7. Notification (real-time via Supabase realtime)
    // Warn the user if delivery was imperfect.
    const notifBody = deliveryStatus === 'full'
      ? (insights?.executive_summary?.slice(0, 140) || 'Your synthetic audience report is ready to review.')
      : deliveryStatus === 'screener_too_restrictive'
        ? `Only ${qualifiedCount} of ${orderedCount} respondents passed your screener. Consider relaxing your screening criteria.`
        : `${qualifiedCount} of ${orderedCount} qualified respondents delivered. Your results are ready.`;

    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_complete',
      title:   `${mission.title || 'Your mission'} results are ready`,
      body:    notifBody,
      link:    `/results/${missionId}`,
    });

    // 8. Email (best-effort)
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
      if (user?.email) {
        await emailService.sendMissionCompleteEmail?.({
          to: user.email,
          missionId,
          missionTitle: mission.title || 'Your research mission',
          executiveSummary: insights?.executive_summary || '',
        });
      }
    } catch (mailErr) {
      logger.warn('Mission run: email send failed', { missionId, err: mailErr.message });
    }
  } catch (err) {
    logger.error('Mission run: fatal', { missionId, err: err.message, stack: err.stack });
    await updateMission(supabase, missionId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    }, { caller: 'runMission: fatal' });

    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_failed',
      title:   'Mission could not complete',
      body:    'We hit an error processing your mission. Our team has been notified.',
      link:    `/results/${missionId}`,
    }).then(() => {}).catch(() => {});
  }
}

module.exports = { runMission };
