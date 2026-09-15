-- Pass 58: the Brand Lift and Creative Attention respondent floors move from
-- NOT VALID CHECK constraints into a trigger that checks only new values.
--
-- WHY
-- Pass 51 added the floors NOT VALID so 16 legacy rows could stay as sold.
-- But Postgres re-checks a NOT VALID constraint on EVERY update of a row, not
-- only updates to the constrained columns. The 16 legacy rows (12 of them
-- paid) could therefore not be updated at all: recording a Stripe refund on
-- them failed with 23514, and the refund webhook would have returned 500 and
-- been retried by Stripe indefinitely.
--
-- WHAT STAYS THE SAME
-- The predicates, numbers, constraint names and error code (check_violation)
-- are unchanged. Every INSERT is checked. Every UPDATE that sets goal_type or
-- respondent_count is checked, including setting it to its existing value.
-- test/db_respondent_floor_constraints.test.js evaluates the predicates below.
--
-- WHY NOT A created_at CUTOFF
-- A signed-in user can insert a draft directly under RLS and choose its
-- created_at, so a date exemption would be a bypass. This has none.
--
-- missions_respondent_count_range_chk is untouched: no row violates it.

ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_brand_lift_respondent_floor_chk;
ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_creative_attention_respondent_floor_chk;

CREATE OR REPLACE FUNCTION public.enforce_mission_respondent_floors() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT (NEW.goal_type <> 'brand_lift' OR NEW.respondent_count IS NULL OR NEW.respondent_count >= 100) THEN
    RAISE EXCEPTION 'Brand Lift missions need at least 100 respondents'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'missions_brand_lift_respondent_floor_chk';
  END IF;
  IF NOT (NEW.goal_type <> 'creative_attention' OR NEW.respondent_count IS NULL OR NEW.respondent_count >= 10) THEN
    RAISE EXCEPTION 'Creative Attention missions need at least 10 respondents'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'missions_creative_attention_respondent_floor_chk';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS missions_respondent_floors ON public.missions;
CREATE TRIGGER missions_respondent_floors
  BEFORE INSERT OR UPDATE OF goal_type, respondent_count ON public.missions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_mission_respondent_floors();
