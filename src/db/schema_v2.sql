-- ================================================================
-- VETT — Schema v2 Migration
-- Run this in your Supabase SQL Editor (safe to run multiple times)
-- ================================================================

-- === PROFILES (extend existing) ===
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS company TEXT,
  ADD COLUMN IF NOT EXISTS user_role TEXT,
  ADD COLUMN IF NOT EXISTS project_stage TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS chat_quota_monthly INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS chat_quota_used_this_month INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_quota_reset_at TIMESTAMPTZ DEFAULT date_trunc('month', now()) + interval '1 month';

-- === MISSIONS (extend existing) ===
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS goal_type TEXT,
  ADD COLUMN IF NOT EXISTS brief TEXT,
  ADD COLUMN IF NOT EXISTS respondent_count INT,
  ADD COLUMN IF NOT EXISTS targeting JSONB,
  ADD COLUMN IF NOT EXISTS questions JSONB,
  ADD COLUMN IF NOT EXISTS base_cost_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS targeting_surcharge_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS extra_questions_cost_usd NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_price_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS promo_code TEXT,
  ADD COLUMN IF NOT EXISTS discount_usd NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS executive_summary TEXT,
  ADD COLUMN IF NOT EXISTS insights JSONB,
  ADD COLUMN IF NOT EXISTS ai_cost_usd NUMERIC(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_cost_usd NUMERIC(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_messages_used INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_quota_limit INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS creative_urls TEXT[];

CREATE INDEX IF NOT EXISTS idx_missions_user ON public.missions(user_id);
CREATE INDEX IF NOT EXISTS idx_missions_status ON public.missions(status);
CREATE INDEX IF NOT EXISTS idx_missions_created ON public.missions(created_at DESC);

-- === MISSION RESPONSES (per persona, per question) ===
CREATE TABLE IF NOT EXISTS public.mission_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id UUID REFERENCES public.missions(id) ON DELETE CASCADE NOT NULL,
  persona_id TEXT NOT NULL,
  persona_profile JSONB NOT NULL,
  question_id TEXT NOT NULL,
  answer JSONB NOT NULL,
  answered_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_responses_mission ON public.mission_responses(mission_id);

ALTER TABLE public.mission_responses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_responses" ON public.mission_responses FOR SELECT USING (
    mission_id IN (SELECT id FROM public.missions WHERE user_id = auth.uid())
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- === AI CALL LOGS ===
CREATE TABLE IF NOT EXISTS public.ai_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id UUID REFERENCES public.missions(id),
  user_id UUID REFERENCES auth.users(id),
  call_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms INT,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_mission ON public.ai_calls(mission_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON public.ai_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_date ON public.ai_calls(created_at DESC);

-- === CHAT SESSIONS ===
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  mission_id UUID REFERENCES public.missions(id),
  scope TEXT NOT NULL,
  messages_count INT DEFAULT 0,
  quota_limit INT NOT NULL DEFAULT 30,
  quota_overage_purchased INT DEFAULT 0,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES public.chat_sessions(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens_in INT,
  tokens_out INT,
  cost_usd NUMERIC(10,6),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_msgs_session ON public.chat_messages(session_id);

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_chats" ON public.chat_sessions FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "users_own_chat_msgs" ON public.chat_messages FOR ALL USING (
    session_id IN (SELECT id FROM public.chat_sessions WHERE user_id = auth.uid())
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- === PROMO CODES ===
CREATE TABLE IF NOT EXISTS public.promo_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'flat')),
  value NUMERIC(10,2) NOT NULL,
  max_uses INT,
  uses_count INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.promo_codes (code, type, value, max_uses, expires_at) VALUES
  ('LAUNCH50', 'percentage', 50, NULL, '2026-12-31'),
  ('VETT20', 'percentage', 20, 100, '2026-06-30'),
  ('FRIEND10', 'flat', 10, 50, '2026-12-31')
ON CONFLICT (code) DO NOTHING;

-- === NOTIFICATIONS ===
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON public.notifications(user_id, read_at);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_notif" ON public.notifications FOR ALL USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- === SUPPORT TICKETS ===
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'open',
  ai_draft_response TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- === BLOG POSTS ===
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  tag TEXT,
  emoji TEXT,
  published_at TIMESTAMPTZ,
  views_count INT DEFAULT 0,
  source_mission_ids UUID[],
  auto_generated BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === CRM LEADS ===
CREATE TABLE IF NOT EXISTS public.crm_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  stage TEXT DEFAULT 'new_lead',
  name TEXT,
  email TEXT,
  company TEXT,
  ltv_usd NUMERIC(10,2) DEFAULT 0,
  health TEXT,
  last_activity_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === RLS for admin (admin sees all missions) ===
DO $$ BEGIN
  CREATE POLICY "admin_all_missions" ON public.missions FOR SELECT USING (
    auth.jwt() ->> 'email' = 'kabbarajamil@gmail.com'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
