-- Pass 34 C3 — ai_calls.purpose column for non-mission attribution.
--
-- Production audit found 33.6% (82/244) of ai_calls have mission_id IS
-- NULL. These are chatbot calls, targeting brief calls, clarify calls,
-- dashboard chat calls — all legitimate but silently dropped from
-- per-mission cost rollups (Pass 33 W3 JOIN). The purpose column lets
-- the admin Costs page bucket those calls without losing them.
--
-- call_type values are written by anthropic.js / creativeAttention.js
-- on every Claude call. We derive purpose from call_type so the
-- mapping stays in one place. Future callers get purpose set
-- automatically by the wrappers.
--
-- Apply via apply_migration as `pass_34_c3_ai_calls_purpose`.

ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS purpose TEXT;

-- Backfill historical 244 rows from call_type. The mapping mirrors the
-- table embedded in anthropic.js:CALL_TYPE_TO_PURPOSE.
UPDATE ai_calls SET purpose = CASE call_type
  -- Mission-pipeline calls (these usually also have mission_id; the
  -- purpose tag is for the rare cases where mission_id was lost in
  -- transit, e.g. CA early-stage frames before the mission row was
  -- linked).
  WHEN 'survey_gen'                   THEN 'mission_pipeline'
  WHEN 'persona_gen'                  THEN 'mission_pipeline'
  WHEN 'response_sim'                 THEN 'mission_pipeline'
  WHEN 'insight_synth'                THEN 'mission_pipeline'
  WHEN 'brand_lift_benchmarks'        THEN 'mission_pipeline'
  WHEN 'creative_attention_frame'     THEN 'mission_pipeline'
  WHEN 'creative_attention_synthesis' THEN 'mission_pipeline'
  WHEN 'results_analysis'             THEN 'mission_pipeline'
  -- Chatbot surfaces.
  WHEN 'chat_setup'      THEN 'chatbot_setup'
  WHEN 'chat_results'    THEN 'chatbot_results'
  WHEN 'chat_dashboard'  THEN 'chatbot_dashboard'
  WHEN 'chat_admin_crm'  THEN 'chatbot_admin'
  -- Brief and targeting helpers (run before mission row exists or
  -- without binding to a specific mission).
  WHEN 'brief_clarify'      THEN 'clarify'
  WHEN 'adaptive_clarify'   THEN 'clarify'
  WHEN 'question_refine'    THEN 'clarify'
  WHEN 'targeting_suggest'  THEN 'targeting_brief'
  WHEN 'targeting_brief'    THEN 'targeting_brief'
  -- Editorial / blog generation.
  WHEN 'blog_gen'           THEN 'blog_gen'
  -- Anything we haven't mapped yet (legacy or pre-Pass-34 logging
  -- artifacts) goes to unknown_legacy so it doesn't pollute the new
  -- bucket counts.
  ELSE 'unknown_legacy'
END
WHERE purpose IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_calls_purpose ON ai_calls(purpose) WHERE purpose IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_calls_purpose_created
  ON ai_calls(purpose, created_at DESC) WHERE mission_id IS NULL;
