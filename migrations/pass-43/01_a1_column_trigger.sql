-- Pass 43 T1b — A.1 column safety net + backfill.
--
-- The root-cause fix lives in app code (client-side Setup insert +
-- backend checkout recompute, Pass 43 T1a). This trigger is the
-- defense-in-depth layer: no mission row — from ANY insert path,
-- present or future — can land with NULL recruitment columns and
-- silently bypass the recruitment loop.
--
-- BEFORE INSERT: populate target_qualified_count from respondent_count,
--   ai_spend_ceiling_usd from total_price_usd (if present), status.
-- BEFORE UPDATE OF total_price_usd: recompute the ceiling when the
--   final price lands (checkout). This is why the trigger covers the
--   client-insert timing gap — at insert total_price_usd is NULL
--   (only price_estimated is set), so the ceiling stays whatever the
--   app provided; when checkout writes total_price_usd, the UPDATE
--   branch fires and recomputes from the authoritative price.

CREATE OR REPLACE FUNCTION public.ensure_recruitment_columns()
RETURNS trigger AS $$
BEGIN
  IF NEW.target_qualified_count IS NULL AND NEW.respondent_count IS NOT NULL THEN
    NEW.target_qualified_count := NEW.respondent_count;
  END IF;
  IF NEW.ai_spend_ceiling_usd IS NULL AND COALESCE(NEW.total_price_usd, 0) > 0 THEN
    NEW.ai_spend_ceiling_usd := ROUND(NEW.total_price_usd * 0.30, 4);
  END IF;
  IF NEW.recruitment_status IS NULL THEN
    NEW.recruitment_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_recruitment_columns ON public.missions;
CREATE TRIGGER trg_ensure_recruitment_columns
  BEFORE INSERT OR UPDATE OF respondent_count, total_price_usd ON public.missions
  FOR EACH ROW EXECUTE FUNCTION public.ensure_recruitment_columns();

-- Backfill existing NULL rows (the two known orphans 3ccfb513,
-- 6efbfe17 plus any others).
UPDATE public.missions
   SET target_qualified_count = respondent_count
 WHERE target_qualified_count IS NULL
   AND respondent_count IS NOT NULL;

UPDATE public.missions
   SET ai_spend_ceiling_usd = ROUND(total_price_usd * 0.30, 4)
 WHERE ai_spend_ceiling_usd IS NULL
   AND COALESCE(total_price_usd, 0) > 0;

UPDATE public.missions
   SET recruitment_status = 'pending'
 WHERE recruitment_status IS NULL;

-- Verification (run after; should each return 0):
--   SELECT count(*) FROM public.missions
--    WHERE target_qualified_count IS NULL AND respondent_count IS NOT NULL;
--   SELECT count(*) FROM public.missions
--    WHERE ai_spend_ceiling_usd IS NULL AND COALESCE(total_price_usd,0) > 0;
