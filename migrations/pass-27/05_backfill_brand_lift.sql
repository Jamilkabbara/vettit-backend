-- Pass 27 — Backfill existing brand_lift missions.
-- Applied via apply_migration as pass_27_backfill_brand_lift_missions.

-- 1. Copy targeting.geography.countries into targeted_markets for any
--    pre-Pass-27 brand_lift mission that has targeting JSON.
UPDATE missions
SET targeted_markets = ARRAY(SELECT jsonb_array_elements_text(targeting->'geography'->'countries'))
WHERE goal_type = 'brand_lift'
  AND (targeted_markets = ARRAY[]::TEXT[] OR targeted_markets IS NULL)
  AND targeting->'geography'->'countries' IS NOT NULL
  AND jsonb_typeof(targeting->'geography'->'countries') = 'array';

-- 2. Default to SA + AE for any brand_lift mission with no targeting JSON.
UPDATE missions
SET targeted_markets = ARRAY['SA', 'AE']
WHERE goal_type = 'brand_lift'
  AND (targeted_markets = ARRAY[]::TEXT[] OR targeted_markets IS NULL)
  AND targeting IS NULL;

-- 3. Backfill exposure_status on existing brand_lift respondents with a
--    deterministic ~50/50 split using the persona_id hash. These are
--    pre-Pass-27 missions where the simulator did NOT generate paired
--    exposed/control samples — assigning post-hoc gives the BrandLift
--    results page a usable signal but the lift values are not real
--    incrementality (just a random-split visualization).
--
-- This caveat is documented in INCREMENTALITY.md.
UPDATE mission_responses
SET exposure_status = CASE
  WHEN ((mission_id::text || persona_id) ~ '^[0-7]')
  THEN 'exposed' ELSE 'control' END
WHERE exposure_status = 'not_applicable'
  AND mission_id IN (SELECT id FROM missions WHERE goal_type = 'brand_lift');
