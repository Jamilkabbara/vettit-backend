-- Pass 30 B1 — Validate Product input columns. Applied via
-- apply_migration as `pass_30_b1_validate_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS concept_description TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS concept_media_url TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS concept_media_type TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS concept_price_usd NUMERIC(10,2);
ALTER TABLE missions ADD COLUMN IF NOT EXISTS concept_use_occasion TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS validate_methodology TEXT DEFAULT 'concept_test';
