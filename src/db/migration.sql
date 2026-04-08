-- ============================================================
-- VETTIT BACKEND MIGRATION
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- This adds the new columns the backend needs
-- Safe to run — uses IF NOT EXISTS everywhere
-- ============================================================

-- ── New columns on missions table ────────────────────────────

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS pollfish_survey_id TEXT,
  ADD COLUMN IF NOT EXISTS pricing_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS ai_insights JSONB,
  ADD COLUMN IF NOT EXISTS launched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mission_statement TEXT;

-- ── Indexes for performance ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_missions_user_status
  ON missions (user_id, status);

CREATE INDEX IF NOT EXISTS idx_missions_pollfish_id
  ON missions (pollfish_survey_id)
  WHERE pollfish_survey_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_missions_payment_intent
  ON missions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ── Storage bucket for uploads ────────────────────────────────
-- Run this separately in Supabase Dashboard → Storage → Create bucket
-- Name: vettit-uploads
-- Public: true (so image URLs work in frontend)

-- ── RLS policies for new columns ─────────────────────────────
-- (Existing policies already cover all columns — no changes needed)

-- ── Verify everything looks correct ──────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'missions'
ORDER BY ordinal_position;
