-- Pass 29 B8 — customer-satisfaction input columns. Applied via
-- apply_migration as `pass_29_b8_csat_inputs`.
--
-- Backs the CSATInputs collector (vett-platform
-- src/components/setup/CSATInputs.tsx) and the NPS + CSAT + CES
-- backend question generator (this repo
-- src/services/claudeAI.js generateCSATSurvey).

ALTER TABLE missions ADD COLUMN IF NOT EXISTS csat_touchpoint TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS csat_custom_touchpoint TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS csat_customer_type TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS csat_recency_window TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS csat_methodology TEXT DEFAULT 'nps_csat_ces';

COMMENT ON COLUMN missions.csat_touchpoint IS
  'Pass 29 B8 — product / support / purchase / onboarding / overall / custom.';
COMMENT ON COLUMN missions.csat_custom_touchpoint IS
  'Pass 29 B8 — free text used when csat_touchpoint=custom.';
COMMENT ON COLUMN missions.csat_customer_type IS
  'Pass 29 B8 — all / new_customers / returning / churned.';
COMMENT ON COLUMN missions.csat_recency_window IS
  'Pass 29 B8 — 30_days / 90_days / 12_months / all_time.';
COMMENT ON COLUMN missions.csat_methodology IS
  'Pass 29 B8 — fixed at nps_csat_ces for now.';
