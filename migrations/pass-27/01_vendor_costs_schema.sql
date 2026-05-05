-- Pass 24 Bug 24.02 — vendor_costs schema + seed.
-- Applied via Supabase MCP apply_migration as
--   pass_24_bug_24_02_vendor_costs_schema
--   pass_24_bug_24_02_seed_vendor_costs
-- This file is the repo-tracked record of the same DDL + DML.

CREATE TABLE IF NOT EXISTS vendor_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('fixed_monthly', 'per_request', 'annual', 'one_time')),
  cost_usd NUMERIC(10,4) NOT NULL,
  cost_unit TEXT NOT NULL,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'api', 'invoice', 'estimate')),
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_costs_active
  ON vendor_costs(vendor, effective_from DESC)
  WHERE effective_to IS NULL;

ALTER TABLE vendor_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vendor_costs_admin_read" ON vendor_costs;
CREATE POLICY "vendor_costs_admin_read" ON vendor_costs
  FOR SELECT TO authenticated
  USING (auth.uid() = '82405ff9-0437-4537-9718-e56113213453'::uuid);

DROP POLICY IF EXISTS "vendor_costs_admin_write" ON vendor_costs;
CREATE POLICY "vendor_costs_admin_write" ON vendor_costs
  FOR ALL TO authenticated
  USING (auth.uid() = '82405ff9-0437-4537-9718-e56113213453'::uuid);

INSERT INTO vendor_costs (vendor, display_name, category, cost_usd, cost_unit, source, notes)
VALUES
  ('vercel', 'Vercel', 'fixed_monthly', 0.00, 'month', 'manual', 'Hobby plan (free)'),
  ('supabase', 'Supabase', 'fixed_monthly', 0.00, 'month', 'manual', 'Free tier'),
  ('railway', 'Railway', 'fixed_monthly', 5.00, 'month', 'manual', 'Hobby plan'),
  ('resend', 'Resend', 'fixed_monthly', 0.00, 'month', 'manual', 'Free tier 3K emails/mo'),
  ('godaddy', 'GoDaddy (M365 + Domain)', 'annual', 136.00, 'year', 'estimate', '500 AED bundle, renews 2028-01-17'),
  ('anthropic', 'Anthropic API', 'per_request', 0.00, 'request', 'api', 'Live from ai_calls table'),
  ('stripe', 'Stripe Processing', 'per_request', 0.029, 'transaction_pct', 'api', '2.9% + $0.30 per charge')
ON CONFLICT DO NOTHING;
