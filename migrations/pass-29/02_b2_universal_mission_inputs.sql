-- Pass 29 B2 — universal mission inputs columns. Applied via
-- apply_migration as `pass_29_b2_universal_mission_inputs`.
--
-- These fields back the UniversalMissionInputs component
-- (vett-platform src/components/setup/UniversalMissionInputs.tsx)
-- and feed every Pass 29+ methodology-bound mission type. Brand
-- Lift + Creative Attention already collect equivalents through
-- their deep pickers but writing here is harmless.
--
-- competitor_brands JSONB already exists from Pass 28 A — reused
-- here without re-adding.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS brand_name TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS audience_description TEXT;

COMMENT ON COLUMN missions.brand_name IS
  'Pass 29 B2 — name of the brand or product being researched.';
COMMENT ON COLUMN missions.category IS
  'Pass 29 B2 — product category (e.g. "energy drink", "B2B SaaS analytics").';
COMMENT ON COLUMN missions.audience_description IS
  'Pass 29 B2 — free-text audience description used by AI to seed screening questions.';
