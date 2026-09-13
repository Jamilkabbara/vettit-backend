-- Pass 54 - ensure_recruitment_columns(): stop deriving the AI spend ceiling
-- from the POST-PROMO total, and stop clobbering the value the writer sent.
--
-- ⚠️  NOT APPLIED. This file ships with the code change that needs it and has
--     deliberately NOT been run against any database. Until it is applied the
--     application-layer fix in this PR is INERT on every path that writes
--     total_price_usd in the same statement, because this trigger overwrites
--     the ceiling after the route has set it. See "WHY THE APP FIX IS NOT
--     ENOUGH" below.
--
-- THE DEFECT
-- migrations/pass-51/02 fixed the trigger's UPDATE branch so that it actually
-- recomputes (the old IS NULL guard made it inert). That fix was right about
-- WHEN to recompute and wrong about WHAT FROM:
--
--   IF COALESCE(NEW.total_price_usd, 0) > 0 THEN
--     NEW.ai_spend_ceiling_usd := ROUND(NEW.total_price_usd * 0.30, 4);
--   END IF;
--
-- `total_price_usd` is what the customer is CHARGED. calculateMissionPrice
-- computes it as subtotal minus the promo discount, and both
-- POST /api/payments/create-checkout-session and POST /api/missions/:id/launch
-- write that post-promo number. So a mission bought with a 50%-off code gets
-- half the AI spend ceiling of an identical full-price mission, for identical
-- work: same respondent count, same recruit loop, same model calls. The
-- ceiling governs COMPUTE. A discount is a revenue decision. They must not be
-- wired to each other.
--
-- This is the same bug the routes had, one layer down - which is the point
-- worth stating plainly: a trigger and a route disagreeing about a basis is
-- not a smaller problem than two routes disagreeing, it is a harder one to
-- see, because the route's code reads correctly and the database quietly
-- overrules it.
--
-- WHY THE APP FIX IS NOT ENOUGH
-- The trigger is BEFORE UPDATE OF (respondent_count, total_price_usd) and its
-- UPDATE branch assigns unconditionally. create-checkout-session sends
-- total_price_usd and ai_spend_ceiling_usd in ONE statement; the trigger fires
-- on that statement and replaces the ceiling the route just computed. The
-- route's number never reaches the row. Today that is invisible, because the
-- route computed the same post-promo figure the trigger does. With the route
-- fixed and this migration unapplied, the row still ends up post-promo.
--
-- THE FIX, IN TWO PARTS
--  1. DO NOT CLOBBER AN EXPLICIT WRITE. If the statement itself supplied a new
--     ai_spend_ceiling_usd, that value is the application's server-computed
--     list-price ceiling and is authoritative. The column is server-owned
--     (REVOKEd from `authenticated` in migrations/pass-50/02), so "the
--     statement supplied it" means a backend route supplied it - no client can
--     reach this branch. `IS DISTINCT FROM OLD` is the test, so a statement
--     that merely re-sends the same value is treated as not having changed it
--     and still gets the recompute below.
--
--  2. WHEN NOTHING WAS SUPPLIED, RECOMPUTE FROM THE LIST BASIS, not from the
--     charge: total_price_usd + discount_usd. discount_usd is written in the
--     same statement by both money routes, and for a statement that touches
--     only total_price_usd the row's existing discount_usd is the right one.
--
-- ACCURACY OF THE SQL FALLBACK, stated rather than glossed. The engine rounds
-- the CHARGE to whole dollars (roundChargeToWholeDollar) after subtracting the
-- discount, so total_price_usd + discount_usd reconstructs the pre-rounding
-- subtotal to within $0.50, i.e. the fallback ceiling can differ from the
-- app's by at most $0.15. That is fine for what this branch now is - a
-- defence-in-depth floor under the routes, for statements that do not carry a
-- ceiling of their own - and it is strictly closer than deriving from the
-- charge alone, which is off by 30% of the entire discount.
--
-- The 0.30 factor, the 4-decimal rounding, the INSERT branch, the
-- target_qualified_count handling and the recruitment_status default are all
-- unchanged.
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
      NEW.ai_spend_ceiling_usd := ROUND(
        (COALESCE(NEW.total_price_usd, 0) + COALESCE(NEW.discount_usd, 0)) * 0.30, 4);
    END IF;
  ELSE
    -- UPDATE OF respondent_count, total_price_usd - an authoritative input
    -- just changed, so the derived columns are recomputed from it whether or
    -- not they already hold a value. This is the branch the pass-43 IS NULL
    -- guard used to disable and pass-51 re-enabled.
    IF NEW.respondent_count IS NOT NULL THEN
      NEW.target_qualified_count := NEW.respondent_count;
    END IF;

    -- The writer set the ceiling in this same statement. It is a server route
    -- handing over a list-price figure it computed with the pricing engine,
    -- which is strictly better than anything reconstructable here. Leave it.
    IF NEW.ai_spend_ceiling_usd IS DISTINCT FROM OLD.ai_spend_ceiling_usd THEN
      NULL;
    -- Nothing was supplied. Derive from the LIST price - the charge plus the
    -- discount that was taken off it - never from the charge alone.
    ELSIF COALESCE(NEW.total_price_usd, 0) > 0 THEN
      NEW.ai_spend_ceiling_usd := ROUND(
        (COALESCE(NEW.total_price_usd, 0) + COALESCE(NEW.discount_usd, 0)) * 0.30, 4);
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
--   SELECT prosrc FROM pg_proc WHERE proname = 'ensure_recruitment_columns';
--   -- no assignment to ai_spend_ceiling_usd may read total_price_usd without
--   -- also reading discount_usd.
--
-- Live check on a discounted purchase (read-only):
--   SELECT id, total_price_usd, discount_usd, ai_spend_ceiling_usd,
--          ROUND((total_price_usd + COALESCE(discount_usd,0)) * 0.30, 4) AS list_basis
--     FROM public.missions
--    WHERE COALESCE(discount_usd, 0) > 0
--    ORDER BY created_at DESC LIMIT 20;
--   -- ai_spend_ceiling_usd should track list_basis, not total_price_usd*0.30.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Re-run migrations/pass-51/02_ensure_recruitment_columns_update_recompute.sql,
-- which restores the previous function body verbatim.
