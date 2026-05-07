-- Pass 33 W4 — re-backfill delivered_respondent_count from
-- mission_responses ground truth.
--
-- The Pass 32 X1 backfill used COUNT(DISTINCT persona_id) which lined
-- up with paid_for and silently masked historical overshoot. Audit on
-- May 8 2026 surfaced 10 missions where the column reported paid_for
-- but the underlying mission_responses had 1.4x-10x more rows.
-- Quantified: 330 extra rows generated across the production set,
-- ~$99 unrecovered API spend on respondents we never charged for.
--
-- New semantics: delivered_respondent_count = total mission_responses
-- row count for that mission, EXCLUDING creative_attention which is
-- delivery_unit='creative_asset' (no respondent rows by design).
--
-- Apply via apply_migration as `pass_33_w4_delivered_respondent_count_backfill`.

UPDATE missions m
SET delivered_respondent_count = (
  SELECT COUNT(*)
  FROM mission_responses mr
  WHERE mr.mission_id = m.id
)
WHERE m.paid_at IS NOT NULL
  AND m.goal_type != 'creative_attention';

-- Creative Attention rows correctly stay at 0 (no respondent table rows).
UPDATE missions m
SET delivered_respondent_count = 0
WHERE m.goal_type = 'creative_attention'
  AND m.paid_at IS NOT NULL;

-- Verification: should return zero rows after backfill.
-- SELECT m.id, m.delivered_respondent_count,
--   (SELECT COUNT(*) FROM mission_responses mr WHERE mr.mission_id = m.id) AS actual
-- FROM missions m
-- WHERE m.paid_at IS NOT NULL
--   AND m.goal_type != 'creative_attention'
--   AND m.delivered_respondent_count != (
--     SELECT COUNT(*) FROM mission_responses mr WHERE mr.mission_id = m.id
--   );
