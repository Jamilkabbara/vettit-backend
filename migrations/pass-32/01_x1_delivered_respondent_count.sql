-- Pass 32 X1 — delivered_respondent_count records actual delivered
-- distinct-persona count. Applied via apply_migration as
-- `pass_32_x1_delivered_respondent_count`.
--
-- Backfilled for all paid missions; going forward populated by
-- runMission.js at completion time.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS delivered_respondent_count INTEGER;

UPDATE missions m
SET delivered_respondent_count = COALESCE(
  (SELECT COUNT(DISTINCT mr.persona_id)
   FROM mission_responses mr
   WHERE mr.mission_id = m.id),
  0
)
WHERE m.paid_at IS NOT NULL;
