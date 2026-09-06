-- Pass 51 — ensure_recruitment_columns(): drop the IS NULL guard on the
-- UPDATE path so the update branch does what it was written to do.
--
-- THE DEFECT
-- migrations/pass-43/01_a1_column_trigger.sql installs this trigger:
--
--   BEFORE INSERT OR UPDATE OF respondent_count, total_price_usd
--
-- and its own header, plus the commit message that shipped it (45b1d8f,
-- "Pass 43 T1b"), states the update branch's purpose in as many words:
--
--   "when checkout writes total_price_usd, the UPDATE-OF branch fires and
--    recomputes the authoritative ceiling."
--
-- It does not. The body guards every assignment on the target column already
-- being NULL:
--
--   IF NEW.ai_spend_ceiling_usd IS NULL AND COALESCE(NEW.total_price_usd,0) > 0
--
-- and by the time checkout writes total_price_usd the ceiling is never NULL —
-- routes/missions.js sets ai_spend_ceiling_usd at create time off the
-- ESTIMATED price (line ~500), and the client Setup insert carries a value
-- too. So on UPDATE the guard is false, the assignment is skipped, and the
-- ceiling that survives is the one derived from the estimate rather than from
-- the price actually charged. The stated reason for listing total_price_usd
-- in the UPDATE OF clause has never once fired.
--
-- The same guard makes the respondent_count half of the UPDATE OF clause
-- inert: change respondent_count on an existing row and target_qualified_count
-- keeps its old value, so the recruit loop goes on targeting the count the
-- mission no longer has. That is the precise failure the trigger exists to
-- prevent, one column over.
--
-- THE FIX
-- Split the body by TG_OP.
--   INSERT: unchanged. The IS NULL guards stay, because on insert they are
--           doing the thing they were written for — total_price_usd is NULL at
--           that point and the app-provided values must be preserved, exactly
--           as the Pass 43 header describes.
--   UPDATE: recompute from the source column unconditionally. The trigger only
--           fires when respondent_count or total_price_usd was actually
--           written, so "recompute" here means "the authoritative input just
--           changed, derive again from it" — never a spontaneous overwrite.
--
-- The 0.30 factor and 4-decimal rounding are unchanged, and still match the
-- app-side writers (routes/payments.js ~245, routes/missions.js ~500/620/938),
-- which remain the primary path. This trigger stays what Pass 43 built it to
-- be: the defense-in-depth layer under them.
--
-- ai_spend_ceiling_usd is server-owned (REVOKEd from `authenticated` in
-- migrations/pass-50/02), so no client can hand-set a ceiling that this
-- recompute would be clobbering.
--
-- Idempotent: CREATE OR REPLACE on the function only. The trigger itself is
-- unchanged and is not re-created here.

BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_recruitment_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Populate what the insert left out. Never overwrite what it provided.
    IF NEW.target_qualified_count IS NULL AND NEW.respondent_count IS NOT NULL THEN
      NEW.target_qualified_count := NEW.respondent_count;
    END IF;
    IF NEW.ai_spend_ceiling_usd IS NULL AND COALESCE(NEW.total_price_usd, 0) > 0 THEN
      NEW.ai_spend_ceiling_usd := ROUND(NEW.total_price_usd * 0.30, 4);
    END IF;
  ELSE
    -- UPDATE OF respondent_count, total_price_usd — an authoritative input
    -- just changed, so the derived columns are recomputed from it whether or
    -- not they already hold a value. This is the branch the IS NULL guard
    -- used to disable.
    -- The remaining IF conditions are input-validity checks on the SOURCE
    -- column (do not derive from a NULL / zero price), not guards on the
    -- target column. Those are the ones that were wrong.
    IF NEW.respondent_count IS NOT NULL THEN
      NEW.target_qualified_count := NEW.respondent_count;
    END IF;
    IF COALESCE(NEW.total_price_usd, 0) > 0 THEN
      NEW.ai_spend_ceiling_usd := ROUND(NEW.total_price_usd * 0.30, 4);
    END IF;
  END IF;

  -- Both paths: recruitment_status must never be NULL.
  IF NEW.recruitment_status IS NULL THEN
    NEW.recruitment_status := 'pending';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- ── Verification (read-only, run after) ─────────────────────────────────────
--   SELECT prosrc FROM pg_proc
--    WHERE proname = 'ensure_recruitment_columns';
--   -- the UPDATE branch must not contain `ai_spend_ceiling_usd IS NULL`.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Re-run migrations/pass-43/01_a1_column_trigger.sql, which restores the
-- previous function body (its backfill UPDATEs are idempotent no-ops once the
-- columns are populated).
