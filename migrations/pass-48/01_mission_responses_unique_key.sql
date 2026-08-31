-- Pass 48 — mission_responses natural-key uniqueness.
--
-- ############################################################
-- ##  NOT APPLIED. ORDERING DEPENDENCY — READ BEFORE RUNNING ##
-- ############################################################
--
-- This migration WILL FAIL on live data until the duplicates are
-- removed. Production currently holds 785 duplicate rows across 3
-- missions (survey run 2026-08-31, read-only):
--
--   bdae4d45-9a85-40f2-a32a-51cce7ef37e0   1440 rows / 720 distinct keys
--   23389bb1-b30f-4b33-a450-37ded4560307    100 rows /  50 distinct keys
--   af36a36d-401d-48e6-b94b-257e215613e2     37 rows /  22 distinct keys
--
-- REQUIRED ORDER:
--   1. node scripts/dedupe-mission-responses.js              (dry run)
--   2. node scripts/dedupe-mission-responses.js --execute    (owner only)
--   3. apply THIS file
--
-- Running this file before step 2 raises
--   ERROR 23505: could not create unique index
--                "mission_responses_mission_persona_question_key"
--   DETAIL: Key (mission_id, persona_id, question_id)=(...) is duplicated.
-- and changes nothing (index creation is transactional).
--
-- WHY THE CONSTRAINT
-- ------------------
-- (mission_id, persona_id, question_id) is the natural key of this
-- table: one row per persona per question. Nothing enforced it, so the
-- two write paths (src/jobs/runMission.js completion insert and
-- src/services/ai/recruitLoop.js incremental insert) could append a
-- whole second copy of a mission's dataset when runMission was
-- re-entered with {resume:true} — which bypasses the idempotency claim
-- by design and is triggered automatically by missionRecovery Job 3.
--
-- Pass 48 adds an application-level skip (src/services/ai/
-- persistResponses.js), but a skip that reads-then-writes loses the
-- concurrent-run race. This index is the only thing that closes it.
-- Once it exists, persistResponseRows' INSERT ... ON CONFLICT DO
-- NOTHING turns the losing racer into a no-op instead of a 23505 that
-- would fail a paid mission. Before it exists that code detects 42P10
-- and falls back to a plain insert, so deploying the app change ahead
-- of this migration is safe (it just isn't race-proof yet).
--
-- Screened-out rows are covered too: a screened-out persona is still
-- one row per question, so the key holds for every row in the table.

CREATE UNIQUE INDEX IF NOT EXISTS mission_responses_mission_persona_question_key
  ON public.mission_responses (mission_id, persona_id, question_id);

COMMENT ON INDEX public.mission_responses_mission_persona_question_key IS
  'Pass 48 — natural key of mission_responses (one row per persona per question). Enforces idempotency of the runMission completion insert and the recruit-loop incremental insert; without it a resumed or concurrently re-entered run appended a second, DIVERGENT copy of the whole dataset (785 duplicate rows across 3 missions before the pass-48 dedupe).';
