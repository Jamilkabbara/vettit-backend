/**
 * VETT — Mission Run Job (the critical path).
 * Triggered by Stripe payment_intent.succeeded webhook.
 *
 * Flow:
 *   1. Generate N personas (Haiku, batched 10x, concurrency 5)
 *   2. Simulate responses per persona (Haiku, concurrency 8)
 *   3. Synthesize insights (Sonnet, single call)
 *   4. Mark mission complete + send notification + email
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

    // Regular survey missions: Generate personas
    const targetCount = mission.respondent_count || 100;
    const personas = await generatePersonas(mission, targetCount);
    logger.info('Mission run: personas generated', { missionId, count: personas.length });

    // 3. Simulate responses
    const responses = await simulateAllResponses(
      personas,
      mission.questions || [],
      mission,
      (completed, total) => {
        // Progress is reflected by mission_responses row count — client polls that.
        if (completed % 25 === 0) logger.info('Mission run: progress', { missionId, completed, total });
      }
    );

    logger.info('Mission run: responses simulated', { missionId, count: responses.length });

    // 4. Bulk insert responses (in chunks to stay under PostgREST limits)
    const CHUNK = 200;
    const rows = responses.map(r => ({
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

    // 6. Compute qualification aggregates from the in-memory persona set.
    //    Pass 21 Bug 5: persist total_simulated_count, qualified_respondent_count,
    //    and qualification_rate on the mission so dashboards/reports never
    //    need to recompute from mission_responses on every read.
    //
    //    Definitions:
    //      total_simulated_count       = number of distinct personas generated
    //      qualified_respondent_count  = personas where ZERO of their answers
    //                                    are flagged screened_out
    //      qualification_rate          = qualified / total  (NULL if total = 0)
    const screenedOutPersonaIds = new Set(
      responses
        .filter(r => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
        .map(r => r.persona_id)
    );
    const allPersonaIds = new Set(personas.map(p => p.persona_id || p.id).filter(Boolean));
    const totalSimulated      = allPersonaIds.size || personas.length;
    const qualifiedRespondent = totalSimulated > 0
      ? Math.max(0, totalSimulated - screenedOutPersonaIds.size)
      : 0;
    const qualificationRate   = totalSimulated > 0
      ? Number((qualifiedRespondent / totalSimulated).toFixed(4))
      : null;

    // 6b. Mark complete — always, regardless of summary outcome
    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      total_simulated_count:       totalSimulated,
      qualified_respondent_count:  qualifiedRespondent,
      qualification_rate:          qualificationRate,
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', { missionId });

    // Funnel event: mission_completed
    supabase.from('funnel_events').insert({
      user_id:    mission.user_id,
      event_type: 'mission_completed',
      mission_id: missionId,
      metadata:   { goal_type: mission.goal_type },
    }).then(() => {}).catch(() => {});

    // 7. Notification (real-time via Supabase realtime)
    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_complete',
      title:   `${mission.title || 'Your mission'} results are ready`,
      body:    insights.executive_summary?.slice(0, 140) || 'Your synthetic audience report is ready to review.',
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
          executiveSummary: insights.executive_summary || '',
        });
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
