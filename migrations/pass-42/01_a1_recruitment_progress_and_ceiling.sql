-- Pass 42 A1 — recruitment progress + AI spend ceiling fields.
-- Apply via Supabase MCP `apply_migration` as
-- `pass_42_a1_recruitment_progress_and_ceiling`.
--
-- Background: Pass 42 reworks mission economics. When a customer pays
-- for N respondents, the backend recruits until N have passed the
-- screener AND completed the full survey. The previous semantics
-- ("delivered = whatever ended up persisted") was wrong because it
-- conflated screened-out personas with qualified respondents (see
-- Pass 41 BUG3 for the over-delivery side-effect of that confusion).
--
-- The 70% margin floor is the absolute economic protection — per-
-- mission AI spend may not exceed mission_price * 0.30. When the
-- ceiling is hit, recruitment stops; synthesis runs on whatever was
-- already qualified; mission completes with `recruitment_status =
-- 'ceiling_hit'`. NO REFUND is issued under any path (policy).

-- ─── columns ─────────────────────────────────────────────────────────
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS target_qualified_count integer,
  ADD COLUMN IF NOT EXISTS recruited_persona_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_spend_usd_actual numeric(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_spend_ceiling_usd numeric(10,4),
  ADD COLUMN IF NOT EXISTS recruitment_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS recruitment_completed_at timestamp with time zone;

COMMENT ON COLUMN public.missions.target_qualified_count IS
  'Pass 42 A1 — number of qualified completes the customer paid for. Recruitment loop runs until this is reached or the AI spend ceiling is hit. Renamed semantics from respondent_count; respondent_count remains as a legacy alias.';

COMMENT ON COLUMN public.missions.recruited_persona_count IS
  'Pass 42 A1 — running total of personas generated (screen pass + fail). Updated by runMission.js as recruitment progresses, throttled to ~5s intervals.';

COMMENT ON COLUMN public.missions.ai_spend_usd_actual IS
  'Pass 42 A1 — accumulated AI cost in USD for this mission. Sum of all Anthropic API call costs from persona generation through synthesis. Tracked at per-call granularity in ai_call_log.';

COMMENT ON COLUMN public.missions.ai_spend_ceiling_usd IS
  'Pass 42 A1 — hard ceiling = mission_price * 0.30 (70% margin floor). When breached the recruitment loop exits; remaining recruitment is skipped; synthesis still runs on whatever qualified. NO refund — policy, codified in customer-facing terms.';

COMMENT ON COLUMN public.missions.recruitment_status IS
  'Pass 42 A1 — pending | recruiting | ceiling_hit | target_hit. ceiling_hit + target_hit are terminal states; recruiting is in-flight; pending is pre-payment.';

COMMENT ON COLUMN public.missions.recruitment_completed_at IS
  'Pass 42 A1 — timestamp the recruitment loop exited (either target_hit or ceiling_hit).';

-- ─── backfill ────────────────────────────────────────────────────────
-- target_qualified_count = respondent_count (preserves what the
-- customer paid for; new column is just renamed semantics).
UPDATE public.missions
   SET target_qualified_count = respondent_count
 WHERE target_qualified_count IS NULL
   AND respondent_count IS NOT NULL;

-- ai_spend_ceiling_usd = total_price_usd * 0.30 for missions that have
-- already been priced. price_estimated is the pre-checkout quote;
-- total_price_usd is the actually-charged amount. Prefer the latter
-- where it exists. Missions with both null are pre-payment drafts and
-- get the ceiling at payment time (Pass 42 A2 sets it).
UPDATE public.missions
   SET ai_spend_ceiling_usd = ROUND(
         COALESCE(total_price_usd, price_estimated)::numeric * 0.30,
         4
       )
 WHERE ai_spend_ceiling_usd IS NULL
   AND COALESCE(total_price_usd, price_estimated) IS NOT NULL;

-- recruitment_status: completed missions get 'target_hit' as a backfill
-- default (we don't actually know how many they over-ran, but for the
-- column to be useful it needs a non-pending value). Pass 41 BUG3
-- already capped delivered_respondent_count so 'target_hit' is
-- accurate from the customer view going forward.
UPDATE public.missions
   SET recruitment_status = 'target_hit',
       recruitment_completed_at = COALESCE(completed_at, now())
 WHERE status = 'completed'
   AND recruitment_status = 'pending';

-- ─── verification queries (run by hand post-migration) ───────────────
-- 1. Confirm every paid+completed mission has a ceiling set.
--    SELECT count(*) FROM public.missions
--     WHERE paid_at IS NOT NULL
--       AND status = 'completed'
--       AND ai_spend_ceiling_usd IS NULL;
--    Expected: 0
--
-- 2. Confirm target_qualified_count matches respondent_count.
--    SELECT count(*) FROM public.missions
--     WHERE target_qualified_count IS DISTINCT FROM respondent_count
--       AND respondent_count IS NOT NULL;
--    Expected: 0
