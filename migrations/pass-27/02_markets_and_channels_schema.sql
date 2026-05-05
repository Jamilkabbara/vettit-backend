-- Pass 27 — markets_master schema + channels_master market support.
-- Applied via apply_migration as pass_27_schema_markets_and_channels.

CREATE TABLE IF NOT EXISTS markets_master (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  region TEXT NOT NULL,
  is_meta_market BOOLEAN DEFAULT FALSE,
  emoji_flag TEXT,
  timezone_default TEXT,
  currency_default TEXT,
  population_millions NUMERIC,
  display_order INTEGER DEFAULT 100
);

CREATE INDEX IF NOT EXISTS idx_markets_region ON markets_master(region);

ALTER TABLE markets_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "markets_master_read_all" ON markets_master;
CREATE POLICY "markets_master_read_all" ON markets_master FOR SELECT USING (TRUE);

ALTER TABLE channels_master ADD COLUMN IF NOT EXISTS markets TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE channels_master ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT FALSE;

-- Backfill existing channels: copy `region` array into `markets` if empty.
UPDATE channels_master SET markets = region WHERE markets = ARRAY[]::TEXT[] AND region IS NOT NULL;

-- Mark global rows so the picker can union `markets && $1 OR is_global = TRUE`.
UPDATE channels_master SET is_global = TRUE, markets = ARRAY['GLOBAL']
  WHERE cardinality(region) >= 5 OR 'global' = ANY(region) OR 'GLOBAL' = ANY(region);

CREATE INDEX IF NOT EXISTS idx_channels_markets_gin ON channels_master USING GIN(markets);
CREATE INDEX IF NOT EXISTS idx_channels_is_global ON channels_master(is_global) WHERE is_global = TRUE;

ALTER TABLE missions ADD COLUMN IF NOT EXISTS targeted_markets TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill existing missions from targeting.geography.countries.
UPDATE missions SET targeted_markets = ARRAY(SELECT jsonb_array_elements_text(targeting->'geography'->'countries'))
  WHERE targeting IS NOT NULL
    AND targeting->'geography'->'countries' IS NOT NULL
    AND jsonb_typeof(targeting->'geography'->'countries') = 'array'
    AND targeted_markets = ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS idx_missions_targeted_markets_gin ON missions USING GIN(targeted_markets);
