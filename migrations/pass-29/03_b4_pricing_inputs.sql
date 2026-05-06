-- Pass 29 B4 — pricing-research input columns. Applied via
-- apply_migration as `pass_29_b4_pricing_inputs`.
--
-- Backs the PricingInputs collector (vett-platform
-- src/components/setup/PricingInputs.tsx) and the Van Westendorp +
-- Gabor-Granger backend question generator (this repo
-- src/services/claudeAI.js generatePricingSurvey).

ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_product_description TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_currency TEXT DEFAULT 'USD';
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_model TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_context TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_expected_min NUMERIC(10,2);
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_expected_max NUMERIC(10,2);
ALTER TABLE missions ADD COLUMN IF NOT EXISTS pricing_methodology TEXT DEFAULT 'van_westendorp_plus_gabor_granger';

COMMENT ON COLUMN missions.pricing_product_description IS
  'Pass 29 B4 — what is being priced (>= 50 chars).';
COMMENT ON COLUMN missions.pricing_currency IS
  'Pass 29 B4 — ISO 4217 code (USD/EUR/GBP/AED/SAR/etc) for VW/GG question wording.';
COMMENT ON COLUMN missions.pricing_model IS
  'Pass 29 B4 — one_time / monthly_subscription / annual_subscription / usage_based.';
COMMENT ON COLUMN missions.pricing_context IS
  'Pass 29 B4 — free text context (competitor prices, current price). Optional but helps AI calibrate VW anchors.';
COMMENT ON COLUMN missions.pricing_expected_min IS
  'Pass 29 B4 — optional lower bound of expected acceptable price range; seeds GG ladder anchors.';
COMMENT ON COLUMN missions.pricing_expected_max IS
  'Pass 29 B4 — optional upper bound of expected acceptable price range.';
COMMENT ON COLUMN missions.pricing_methodology IS
  'Pass 29 B4 — fixed at van_westendorp_plus_gabor_granger for now. Open enum for future Conjoint additions.';
