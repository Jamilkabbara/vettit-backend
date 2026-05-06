-- Pass 29 B6 — feature-roadmap input columns. Applied via
-- apply_migration as `pass_29_b6_roadmap_inputs`.
--
-- Backs the FeatureListCollector (vett-platform
-- src/components/setup/FeatureListCollector.tsx) and the MaxDiff +
-- Kano backend question generator (this repo
-- src/services/claudeAI.js generateRoadmapSurvey).

ALTER TABLE missions ADD COLUMN IF NOT EXISTS roadmap_features JSONB DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS roadmap_methodology TEXT DEFAULT 'max_diff_plus_kano';

COMMENT ON COLUMN missions.roadmap_features IS
  'Pass 29 B6 — array of feature objects [{id, name, description?}]. Min 6, max 30. Drives MaxDiff set generation + Kano follow-up pairs.';
COMMENT ON COLUMN missions.roadmap_methodology IS
  'Pass 29 B6 — fixed at max_diff_plus_kano for now. Open enum for future Conjoint or feature-prioritization additions.';
