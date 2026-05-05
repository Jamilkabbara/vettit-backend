-- Pass 27 — price_breakdown JSONB column on missions.
-- Applied via apply_migration as pass_27_price_breakdown_column.
-- Stores { base_usd, market_uplift_usd, channel_uplift_usd, total_usd,
-- market_count, channel_count, ladder_version } at payment-time so we
-- can audit price-vs-actual + re-price retroactively if tiers change.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS price_breakdown JSONB;
