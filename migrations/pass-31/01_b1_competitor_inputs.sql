-- Pass 31 B1 — Competitor Analysis (Brand Health Tracker) input columns.
-- Applied via apply_migration as `pass_31_b1_competitor_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS attribute_battery TEXT[]
  DEFAULT ARRAY['trustworthy','innovative','premium','affordable','high_quality','modern','traditional','reliable','easy_to_use','customer_friendly'];
ALTER TABLE missions ADD COLUMN IF NOT EXISTS competitor_methodology TEXT DEFAULT 'brand_health_tracker';
