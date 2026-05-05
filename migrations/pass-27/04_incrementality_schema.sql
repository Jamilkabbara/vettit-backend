-- Pass 27 — Incrementality schema (exposed vs control vs not_applicable).
-- Applied via apply_migration as pass_27_incrementality_schema.
--
-- The codebase uses a single denormalized mission_responses table for
-- both persona-level and response-level data (one row per persona per
-- question). exposure_status is constant for a given persona so it
-- repeats across that persona's response rows — that's intentional;
-- it lets aggregation filter without joining.
--
-- The simulator (Pass 27 F18) sets exposure_status to 'exposed' or
-- 'control' for brand_lift goal_type missions only. All other goal
-- types stay at 'not_applicable'.

ALTER TABLE mission_responses ADD COLUMN IF NOT EXISTS exposure_status TEXT
  DEFAULT 'not_applicable'
  CHECK (exposure_status IN ('exposed', 'control', 'not_applicable'));

CREATE INDEX IF NOT EXISTS idx_mission_responses_exposure
  ON mission_responses(mission_id, exposure_status);

UPDATE mission_responses SET exposure_status = 'not_applicable'
  WHERE exposure_status IS NULL;
