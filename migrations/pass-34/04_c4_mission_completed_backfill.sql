-- Pass 34 C4 — backfill missing mission_completed funnel events.
--
-- Production audit found 25 of 29 paid-completed missions never fired
-- the mission_completed event. The runMission post-completion hook
-- emits the event via fire-and-forget `.then().catch()` and silently
-- drops failures. Code fix in src/jobs/runMission.js makes the insert
-- awaited + logged; this migration backfills the historical gap so
-- funnel charts report accurate completion rates.
--
-- Apply via apply_migration as `pass_34_c4_mission_completed_backfill`.

INSERT INTO funnel_events (event_type, user_id, session_id, mission_id, metadata, created_at)
SELECT
  'mission_completed',
  m.user_id,
  NULL,
  m.id,
  jsonb_build_object(
    'goal_type', m.goal_type,
    'delivery_status', m.delivery_status,
    'paid_for', m.respondent_count,
    'delivered', m.delivered_respondent_count,
    'backfill', 'pass_34_c4'
  ),
  COALESCE(m.completed_at, m.paid_at, NOW())
FROM missions m
LEFT JOIN funnel_events fe
  ON fe.mission_id = m.id
  AND fe.event_type = 'mission_completed'
WHERE m.status = 'completed'
  AND m.paid_at IS NOT NULL
  AND fe.id IS NULL;
