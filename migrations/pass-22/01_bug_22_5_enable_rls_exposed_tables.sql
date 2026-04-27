-- Pass 22 Bug 22.5 — Enable RLS on 3 public tables exposed to PostgREST.
--
-- Forensic: pre-flight Supabase advisor flagged stripe_webhook_events,
-- admin_alerts, and payment_errors as having RLS disabled in the public
-- schema. Anyone with the anon key could SELECT/INSERT/DELETE them.
--
-- Strategy:
--   1) Enable RLS on each table.
--   2) Add admin-only ALL policy (read+write) using is_admin_user.
--   3) For payment_errors, add an additional SELECT policy so a user can
--      read their own failure rows (helpful for client-side debug/UI).
--   4) Use (SELECT auth.uid()) form (initplan-cached) so Bug 22.12 doesn't
--      need to rewrite these later.
--
-- Note: Supabase's service_role bypasses RLS, so backend inserts from the
-- webhook handler / route handlers continue to work without explicit
-- INSERT policies.
--
-- Verification:
--   * pg_class.relrowsecurity = true for all 3 tables
--   * pg_policies has 4 rows across the 3 tables
--   * mcp_supabase_get_advisors security: 3 ERROR entries dropped to 0

-- ── stripe_webhook_events ──────────────────────────────────────────────
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stripe_webhook_events_admin_all" ON public.stripe_webhook_events;
CREATE POLICY "stripe_webhook_events_admin_all"
  ON public.stripe_webhook_events
  FOR ALL
  TO authenticated
  USING (public.is_admin_user((SELECT auth.uid())))
  WITH CHECK (public.is_admin_user((SELECT auth.uid())));

-- ── admin_alerts ───────────────────────────────────────────────────────
ALTER TABLE public.admin_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_alerts_admin_all" ON public.admin_alerts;
CREATE POLICY "admin_alerts_admin_all"
  ON public.admin_alerts
  FOR ALL
  TO authenticated
  USING (public.is_admin_user((SELECT auth.uid())))
  WITH CHECK (public.is_admin_user((SELECT auth.uid())));

-- ── payment_errors ─────────────────────────────────────────────────────
ALTER TABLE public.payment_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_errors_admin_select" ON public.payment_errors;
CREATE POLICY "payment_errors_admin_select"
  ON public.payment_errors
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user((SELECT auth.uid())));

DROP POLICY IF EXISTS "payment_errors_user_own_select" ON public.payment_errors;
CREATE POLICY "payment_errors_user_own_select"
  ON public.payment_errors
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

COMMENT ON TABLE public.stripe_webhook_events IS
  'Stripe webhook event log. RLS: admin-only (is_admin_user). Service role bypasses RLS for inserts from webhook handler. (Pass 22 Bug 22.5)';
COMMENT ON TABLE public.admin_alerts IS
  'Admin alert queue. RLS: admin-only (is_admin_user). Service role bypasses RLS for inserts from cron/jobs. (Pass 22 Bug 22.5)';
COMMENT ON TABLE public.payment_errors IS
  'Stripe/checkout error log. RLS: admin-read-all + user-own-read. Service role bypasses RLS for inserts. (Pass 22 Bug 22.5)';
