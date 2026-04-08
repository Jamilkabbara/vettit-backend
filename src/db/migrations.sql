-- ================================================================
-- VETTIT BACKEND — Additional Database Columns
-- Run this in your Supabase SQL Editor
-- ================================================================

-- Add backend-required columns to missions table
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS pollfish_survey_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS pricing_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS ai_insights JSONB,
  ADD COLUMN IF NOT EXISTS launched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mission_statement TEXT;

-- Create index for Pollfish survey lookups (for webhooks)
CREATE INDEX IF NOT EXISTS idx_missions_pollfish_survey_id ON missions(pollfish_survey_id);
CREATE INDEX IF NOT EXISTS idx_missions_payment_status ON missions(payment_status);

-- Ensure profiles table exists with all needed columns
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  full_name TEXT,
  company_name TEXT,
  tax_id TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'AE',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies for profiles
DO $$ BEGIN
  CREATE POLICY "Users can view own profile" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach trigger if not exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create storage bucket for uploads (run once)
-- NOTE: Also do this in Supabase Dashboard → Storage → New Bucket
-- Bucket name: vettit-uploads, Public: true
INSERT INTO storage.buckets (id, name, public)
VALUES ('vettit-uploads', 'vettit-uploads', true)
ON CONFLICT DO NOTHING;

-- Storage RLS
DO $$ BEGIN
  CREATE POLICY "Users can upload own files" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'vettit-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Anyone can view uploaded files" ON storage.objects FOR SELECT TO public
    USING (bucket_id = 'vettit-uploads');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete own files" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'vettit-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
