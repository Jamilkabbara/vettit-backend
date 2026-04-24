/**
 * VETT — Stuck mission recovery job (Pass 19 Task 6).
 *
 * Missions can get stuck in 'processing' if:
 *   - The server crashed mid-run
 *   - runMission() threw an unhandled error before the fatal catch updated status
 *   - A race between the webhook and /api/payments/confirm left the row in limbo
 *
 * This cron job runs every 15 minutes and:
 *   1. Finds missions stuck in 'processing' for > STUCK_THRESHOLD_MINUTES
 *   2. Checks whether they already have responses (partial success)
 *   3. If they have enough responses → synthesises insights and marks complete
 *   4. If they have too few responses → re-queues via runMission()
 *   5. Writes an admin_alert for each recovered mission
 *
 * Idempotent: the runMission() idempotency guard (paid → processing claim)
 * prevents double-execution even if this job overlaps with a live run.
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { runMission } = require('./runMission');
const { updateMission } = require('../db/missionSchema');

const STUCK_THRESHOLD_MINUTES = 45;  // missions processing longer than this are stuck
const MIN_RESPONSES_FOR_INSIGHTS = 5; // minimum response rows to attempt synthesis

/**
 * Entry point. Call from a cron scheduler (e.g., node-cron or Railway cron).
 */
async function recoverStuckMissions() {
  logger.info('recoverStuckMissions: starting scan');

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuckMissions, error } = await supabase
    .from('missions')
    .select('id, user_id, title, started_at, status')
    .eq('status', 'processing')
    .lt('started_at', cutoff);

  if (error) {
    logger.error('recoverStuckMissions: query failed', { err: error.message });
    return;
  }

  if (!stuckMissions || stuckMissions.length === 0) {
    logger.info('recoverStuckMissions: no stuck missions found');
    return;
  }

  logger.warn('recoverStuckMissions: found stuck missions', {
    count: stuckMissions.length,
    ids: stuckMissions.map(m => m.id),
  });

  for (const mission of stuckMissions) {
    await recoverOneMission(mission);
  }

  logger.info('recoverStuckMissions: scan complete', { processed: stuckMissions.length });
}

async function recoverOneMission(mission) {
  const missionId = mission.id;
  logger.info('recoverStuckMissions: recovering', { missionId, stuckSince: mission.started_at });

  try {
    // Count how many response rows already exist.
    const { count, error: countErr } = await supabase
      .from('mission_responses')
      .select('id', { count: 'exact', head: true })
      .eq('mission_id', missionId);

    if (countErr) {
      logger.warn('recoverStuckMissions: response count failed', { missionId, err: countErr.message });
    }

    const responseCount = count ?? 0;
    logger.info('recoverStuckMissions: response count', { missionId, responseCount });

    if (responseCount >= MIN_RESPONSES_FOR_INSIGHTS) {
      // Partial data present — re-set to 'paid' so runMission() can claim it
      // and either oversample (if short) or synthesise from existing responses.
      logger.info('recoverStuckMissions: has responses, re-queueing via runMission()', {
        missionId, responseCount,
      });

      // Reset status to 'paid' so the idempotency guard in runMission() allows it.
      await updateMission(supabase, missionId, {
        status: 'paid',
      }, { caller: 'recoverStuckMissions: re-queue' });

      // Re-run in background — don't await
      setImmediate(() => {
        runMission(missionId).catch(err => {
          logger.error('recoverStuckMissions: runMission re-queue failed', {
            missionId, err: err.message,
          });
        });
      });

    } else {
      // No/very few responses — the job died very early. Mark as failed and
      // notify the user.
      logger.warn('recoverStuckMissions: no responses, marking failed', { missionId });

      await updateMission(supabase, missionId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      }, { caller: 'recoverStuckMissions: mark failed' });

      await supabase.from('notifications').insert({
        user_id: mission.user_id,
        type:    'mission_failed',
        title:   'Mission could not complete',
        body:    'We hit an error processing your mission and our recovery system could not restart it. Please contact support.',
        link:    `/results/${missionId}`,
      }).catch(() => {});
    }

    // Always raise an admin alert so the team can investigate.
    await supabase.from('admin_alerts').insert({
      alert_type: 'stuck_mission_recovered',
      mission_id: missionId,
      user_id:    mission.user_id,
      payload: {
        stuck_since:     mission.started_at,
        response_count:  responseCount,
        action:          responseCount >= MIN_RESPONSES_FOR_INSIGHTS ? 're_queued' : 'marked_failed',
        recovery_ts:     new Date().toISOString(),
      },
    }).catch(e => logger.warn('recoverStuckMissions: admin_alert insert failed', { err: e.message }));

  } catch (err) {
    logger.error('recoverStuckMissions: fatal error for mission', {
      missionId, err: err.message, stack: err.stack,
    });
  }
}

module.exports = { recoverStuckMissions };
