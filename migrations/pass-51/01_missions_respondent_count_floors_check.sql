-- Pass 51 — respondent_count range + per-goal respondent floors, enforced in
-- the DATABASE.
--
-- WHY THE DB AND NOT JUST THE APP
-- The floors already exist in src/utils/pricingEngine.js and are enforced by
-- validateMissionPricing on the API routes that create, re-price or charge a
-- mission. But the main UI path does not go through those routes: the Setup
-- page inserts the mission row directly with supabase-js under RLS
-- (MissionSetupPage.tsx, three insert sites). An insert on that path never
-- calls validateMissionPricing, so a below-floor or above-cap row can land in
-- `missions` with nothing to stop it. A CHECK constraint is the only layer
-- that path cannot bypass, because it is the same layer the insert lands on.
--
-- THE NUMBERS, AND WHERE THEY COME FROM
-- Derived from src/utils/pricingEngine.js (not invented here):
--   MAX_SELF_SERVE_RESPONDENTS = 1250   (self-serve delivery ceiling)
--   BRAND_LIFT_MIN_RESPONDENTS =  100   (exposed/control split floor)
--   CA_MIN_RESPONDENTS         =   10   (creative_attention floor)
-- test/db_respondent_floor_constraints.test.js reads BOTH this file and the
-- pricing engine and fails if the two ever disagree, so the constraint cannot
-- silently drift away from the code that computes the price.
--
-- APPLIED TO PRODUCTION 2026-09-06. Verified: 3 constraints present, all
-- convalidated=false; 16 historical violating rows untouched; below-floor
-- inserts rejected, a legal insert still accepted. VALIDATE CONSTRAINT was
-- deliberately NOT run and must not be.
--
-- >>> IF YOU ARE CHANGING THE CEILING, READ FIRST:
-- >>> docs/operational/raising-the-self-serve-ceiling.md
-- >>> The database must be widened BEFORE the env var, or the app will accept
-- >>> missions the database rejects, and the error lands on the customer at
-- >>> the end of setup because the UI inserts the row directly.
--
-- ONE CAVEAT ON 1250: in the engine the ceiling is
-- `Number(process.env.MAX_SELF_SERVE_RESPONDENTS || 1250)` — env-overridable
-- at runtime. A CHECK constraint cannot read an env var, so 1250 is frozen
-- here. If the ceiling is ever raised via that env var, THIS CONSTRAINT
-- BECOMES THE BINDING LIMIT and must be altered in the same change. That is
-- the intended failure mode (refuse, loudly) rather than the alternative.
--
-- WHY NOT VALID
-- Production currently holds 16 rows that violate these predicates:
--     6  brand_lift          with respondent_count < 100 (5, 5, 5, 5, 10, 20)
--    10  creative_attention  with respondent_count < 10  (all 1)
-- By state: 10 completed+paid, 2 failed+paid, 2 draft, 2 expired.
-- Twelve of them were paid for and delivered. Rewriting respondent_count on a
-- paid, completed study would falsify what the customer actually bought, so
-- there is NO backfill here and none is proposed for those rows. ADD
-- CONSTRAINT ... NOT VALID enforces every future INSERT and every future
-- UPDATE while leaving the historical rows as they are, which is exactly the
-- split we want.
--
-- CONSEQUENCE TO KNOW ABOUT: NOT VALID skips existing rows at ADD time, but it
-- DOES check rows on subsequent UPDATE. The 2 legacy brand_lift drafts and 2
-- expired creative_attention rows can therefore no longer be updated in place
-- without also bringing respondent_count up to the floor. That is correct
-- behaviour (an under-floor draft should not be editable into a purchase), but
-- it is a behaviour change, not a no-op. The optional draft-only repair at the
-- bottom of this file addresses it if the owner wants those two drafts usable
-- again. It is commented out and deliberately never touches a paid row.
--
-- Do NOT run VALIDATE CONSTRAINT on any of these unless the historical rows
-- have first been dealt with deliberately — it will fail, and that is the
-- point.
--
-- NULLs: respondent_count and goal_type are both nullable on this table.
-- Every predicate below is written to PASS on NULL. Making respondent_count
-- NOT NULL is a separate decision with its own insert-path audit, and is out
-- of scope here.

BEGIN;

-- 1. Range. respondent_count is either absent, or a real count no larger than
--    the self-serve ceiling. Above the ceiling a study is a managed
--    engagement, priced by hand — it must not exist as a self-serve row.
ALTER TABLE public.missions
  ADD CONSTRAINT missions_respondent_count_range_chk
  CHECK (
    respondent_count IS NULL
    OR (respondent_count >= 1 AND respondent_count <= 1250)
  ) NOT VALID;

-- 2. brand_lift floor. Below 100 the exposed/control split cannot detect a
--    realistic lift; the ladder has no tier there and the engine refuses to
--    price it off another ladder (UnpriceableMissionError).
ALTER TABLE public.missions
  ADD CONSTRAINT missions_brand_lift_respondent_floor_chk
  CHECK (
    goal_type <> 'brand_lift'
    OR respondent_count IS NULL
    OR respondent_count >= 100
  ) NOT VALID;

-- 3. creative_attention floor. Below 10 respondents there is no attention
--    signal to aggregate, and resolveTier returns null for the combination.
ALTER TABLE public.missions
  ADD CONSTRAINT missions_creative_attention_respondent_floor_chk
  CHECK (
    goal_type <> 'creative_attention'
    OR respondent_count IS NULL
    OR respondent_count >= 10
  ) NOT VALID;

COMMIT;


-- ── Verification (read-only, run after) ─────────────────────────────────────
--   SELECT conname, convalidated, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'public.missions'::regclass
--      AND conname LIKE 'missions_%respondent%chk';
--   -- expect three rows, convalidated = false on each.
--
-- ── OPTIONAL, OWNER DECISION, NOT PART OF THIS MIGRATION ────────────────────
-- Raise the two legacy UNPAID brand_lift drafts to the floor so they can be
-- edited again. Guarded on paid_at IS NULL and status = 'draft' so it can
-- never touch a paid or delivered study. Left commented out on purpose.
--
--   UPDATE public.missions
--      SET respondent_count = 100
--    WHERE goal_type = 'brand_lift'
--      AND status = 'draft'
--      AND paid_at IS NULL
--      AND respondent_count IS NOT NULL
--      AND respondent_count < 100;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   ALTER TABLE public.missions
--     DROP CONSTRAINT IF EXISTS missions_respondent_count_range_chk,
--     DROP CONSTRAINT IF EXISTS missions_brand_lift_respondent_floor_chk,
--     DROP CONSTRAINT IF EXISTS missions_creative_attention_respondent_floor_chk;
