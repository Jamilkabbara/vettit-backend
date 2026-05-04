-- Pass 25 Phase 1A — Brand Lift Study v2 schema.
-- Applied via Supabase MCP apply_migration on 2026-05-04 as
-- migration pass_25_phase_1_brand_lift_v2_schema. This file is the
-- repo-tracked record of the same DDL.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS creative_metadata JSONB;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_channels JSONB DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS wave_config JSONB;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS competitor_brands JSONB DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS brand_lift_template TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS brand_lift_kpis JSONB DEFAULT '[]'::jsonb;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS linked_mission_ids UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE missions ADD COLUMN IF NOT EXISTS wave_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_missions_brand_lift ON missions(goal_type) WHERE goal_type = 'brand_lift';
CREATE INDEX IF NOT EXISTS idx_missions_linked ON missions USING GIN(linked_mission_ids);

CREATE TABLE IF NOT EXISTS brand_lift_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  industry TEXT NOT NULL,
  region_key TEXT NOT NULL,
  channel_mix_hash TEXT NOT NULL,
  audience_segment TEXT,
  kpi_template TEXT NOT NULL,
  benchmarks JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  source TEXT DEFAULT 'ai_estimate',
  confidence TEXT DEFAULT 'medium'
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_lookup
  ON brand_lift_benchmarks(industry, region_key, channel_mix_hash, audience_segment, kpi_template);

CREATE TABLE IF NOT EXISTS channels_master (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  region TEXT[] DEFAULT ARRAY[]::TEXT[],
  description TEXT,
  is_mena_specific BOOLEAN DEFAULT FALSE,
  default_formats TEXT[] DEFAULT ARRAY[]::TEXT[],
  display_order INTEGER DEFAULT 100
);

ALTER TABLE brand_lift_benchmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bench_read ON brand_lift_benchmarks;
CREATE POLICY bench_read ON brand_lift_benchmarks FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS channels_read ON channels_master;
CREATE POLICY channels_read ON channels_master FOR SELECT TO anon, authenticated USING (true);
