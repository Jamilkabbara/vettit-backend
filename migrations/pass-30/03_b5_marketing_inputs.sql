-- Pass 30 B5 — Test Marketing/Ads (ad effectiveness) input columns.
-- Applied via apply_migration as `pass_30_b5_marketing_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS creative_media_url TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS creative_media_type TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_channel TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_format TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_objective TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS intended_message TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS ad_methodology TEXT DEFAULT 'ad_effectiveness';
