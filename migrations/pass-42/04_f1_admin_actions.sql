-- Pass 42 F1 — admin_actions audit log.
--
-- Records every privileged admin override (mark-mission-paid,
-- force-complete, etc.) so we have an audit trail of who did what
-- and why. Frontend admin panel surfaces a list view in a later
-- pass; for now the table just gets populated.

CREATE TABLE IF NOT EXISTS public.admin_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type     text NOT NULL,                -- e.g. 'mark_mission_paid'
  target_type     text NOT NULL,                -- 'mission' | 'promo_code' | ...
  target_id       uuid NOT NULL,
  reason          text,
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_admin   ON public.admin_actions(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target  ON public.admin_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON public.admin_actions(created_at DESC);

COMMENT ON TABLE public.admin_actions IS
  'Pass 42 F1 — audit trail for admin overrides (mark mission paid, etc.). Insert-only from server-side admin routes.';
