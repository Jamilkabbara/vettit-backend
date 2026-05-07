-- Pass 31 B5 — Churn Research input columns. Applied via
-- apply_migration as `pass_31_b5_churn_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS churn_definition TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS churn_custom_definition TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS churn_customer_type TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS churn_winback_possible BOOLEAN DEFAULT FALSE;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS churn_methodology TEXT DEFAULT 'driver_tree';
