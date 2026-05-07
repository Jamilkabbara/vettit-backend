-- Pass 31 B3 — Naming & Messaging input columns. Applied via
-- apply_migration as `pass_31_b3_naming_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS naming_test_type TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS naming_candidates JSONB DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS naming_criteria TEXT[]
  DEFAULT ARRAY['memorable','distinctive','relevant','positive','easy_to_pronounce'];
ALTER TABLE missions ADD COLUMN IF NOT EXISTS naming_methodology TEXT DEFAULT 'monadic_plus_paired';
ALTER TABLE missions ADD COLUMN IF NOT EXISTS brand_personality TEXT;
