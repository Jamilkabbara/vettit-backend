-- Pass 35 A6 — Admin Support: schema + minimal seed.
--
-- Was a "Coming soon" stub in the admin sidebar since Pass 30.
-- Sales-readiness gate: customers will email about issues; we need a
-- place to track them. Schema covers status + priority workflow,
-- channel attribution (web/email/mobile/api), and admin notes via
-- the resolved_at timestamp.
--
-- Apply via apply_migration as `pass_35_a6_support_tickets`.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  mission_id UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  channel TEXT NOT NULL DEFAULT 'web'
    CHECK (channel IN ('web', 'email', 'mobile', 'api')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  admin_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON public.support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON public.support_tickets(created_at DESC);

-- RLS: lock down to admins only via service-role; customer-side surface
-- (Pass 36) will use a SECURITY DEFINER RPC for `INSERT`.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.support_tickets FROM PUBLIC, anon, authenticated;

-- Seed: 1 system test ticket so the admin tab renders with content
-- on first load.
INSERT INTO public.support_tickets (subject, body, status, priority, channel, admin_notes)
VALUES (
  'System test — Pass 35 A6 seed',
  'This is a system-test ticket created during the Pass 35 admin Support build. Safe to mark resolved.',
  'open',
  'low',
  'web',
  'Pass 35 A6 seed row'
)
ON CONFLICT DO NOTHING;
