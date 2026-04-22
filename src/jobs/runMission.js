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

    // 2. Generate personas
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
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: insErr } = await supabase
        .from('mission_responses')
        .insert(rows.slice(i, i + CHUNK));
      if (insErr) logger.warn('Mission run: responses insert chunk failed', { missionId, err: insErr });
    }

    // 5. Synthesize insights
    const insights = await synthesizeInsights(mission, responses);

    // 6. Mark complete
    await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights.executive_summary || null,
      insights: insights || null,
    }, { caller: 'runMission: complete' });

    logger.info('Mission run: complete', { missionId });

    // 7. Notification (real-time via Supabase realtime)
    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_complete',
      title:   `${mission.title || 'Your mission'} results are ready`,
      body:    insights.executive_summary?.slice(0, 140) || 'Your synthetic audience report is ready to review.',
      link:    `/results?missionId=${missionId}`,
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
    await updateMission(supabase, missionId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    }, { caller: 'runMission: fatal' });

    await supabase.from('notifications').insert({
      user_id: mission.user_id,
      type:    'mission_failed',
      title:   'Mission could not complete',
      body:    'We hit an error processing your mission. Our team has been notified.',
      link:    `/results?missionId=${missionId}`,
    }).then(() => {}).catch(() => {});
  }
}

module.exports = { runMission };
