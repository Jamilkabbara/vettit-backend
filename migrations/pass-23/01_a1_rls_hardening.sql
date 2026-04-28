-- Pass 23 Batch A1 — close the 4 INFO RLS-no-policy advisor entries.
-- Applied live as pass_23_a1_rls_hardening; this is the audit-trail snapshot.
--
-- Forensic-driven decisions:
--
-- Bug 23.1 — promo_codes: DENY-ALL client (Path A confirmed by user).
--   Frontend never queries promo_codes via supabase-js (verified by grep).
--   Promo validation goes through /api/pricing/quote (server, service_role).
--   Restores pre-Bug-22.12 deny posture; prevents VETT100 / future code
--   enumeration via anon REST scrape.
--   Pushed back on the prompt's permissive-read suggestion: it would have
--   leaked active codes (including VETT100 free-launch) to anyone with the
--   anon key.
--
-- Bug 23.2 — cron_locks: SERVICE-ONLY (USING (false)).
--   Cron writes via service_role; no client should ever read.
--
-- Bug 23.3 — ai_calls: USER-OWN SELECT + ADMIN ALL (NOT deny-all).
--   Initial read of the prompt suggested deny-all because no direct
--   from('ai_calls') call from frontend code. BUT: AdminAICosts.tsx
--   subscribes to a Supabase realtime channel on ai_calls INSERT for the
--   live cost ticker. Realtime broadcasts respect RLS — service_role
--   bypass does NOT apply to realtime subscriptions made from normal
--   supabase-js clients. Deny-all would silence the admin's realtime
--   ticker entirely. USER-OWN + ADMIN preserves admin realtime + opens
--   future "your AI usage" UI on profile pages without further migrations.
--
-- Bug 23.4 — crm_leads: ADMIN-ONLY.
--   Lead intake writes via service_role (signup webhooks, public capture
--   form). Admin viewer is the only client read path.
--
-- Verification (post-apply):
--   * pg_policies: 5 policies present (4 tables, ai_calls has 2).
--   * Anon REST canaries on /rest/v1/{promo_codes,cron_locks,ai_calls,crm_leads}:
--     all return [] (0 rows).
--   * mcp_supabase_get_advisors security: 4 INFO RLS-no-policy entries → 0.
--     Final state: 0 ERROR, 2 intentional WARN (is_admin_user D1 + leaked-pwd D2),
--     0 INFO.
--   * /api/admin/overview no-JWT: 401 (auth middleware unaffected).

-- ─── Bug 23.1 — promo_codes deny-all ─────────────────────────────────────
CREATE POLICY promo_codes_deny_client_access ON public.promo_codes
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY promo_codes_deny_client_access ON public.promo_codes IS
  'Pass 23 Bug 23.1: client reads/writes denied by design. Promo validation happens server-side via /api/pricing/quote (service_role bypasses RLS). Restores pre-Pass-22-Bug-22.12 deny posture; prevents VETT100/future code enumeration via anon REST scrape.';

-- ─── Bug 23.2 — cron_locks service-only ──────────────────────────────────
CREATE POLICY cron_locks_service_only ON public.cron_locks
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY cron_locks_service_only ON public.cron_locks IS
  'Pass 23 Bug 23.2: cron acquires/releases via service_role; no client should ever read. Single deny-all policy.';

-- ─── Bug 23.3 — ai_calls user-own SELECT + admin ALL ─────────────────────
-- Realtime subscription in AdminAICosts.tsx requires SELECT permission;
-- service_role bypass doesn't apply to realtime channels.
CREATE POLICY ai_calls_user_own_select ON public.ai_calls
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY ai_calls_admin_all ON public.ai_calls
  FOR ALL TO authenticated
  USING (public.is_admin_user((SELECT auth.uid())))
  WITH CHECK (public.is_admin_user((SELECT auth.uid())));

COMMENT ON POLICY ai_calls_user_own_select ON public.ai_calls IS
  'Pass 23 Bug 23.3: user can SELECT their own ai_calls rows. Backend write path uses service_role (bypasses RLS). Required for AdminAICosts realtime subscription which respects RLS.';
COMMENT ON POLICY ai_calls_admin_all ON public.ai_calls IS
  'Pass 23 Bug 23.3: admin (is_admin_user) can SELECT all rows. Powers the realtime AI-cost ticker in AdminAICosts.tsx (realtime channels respect RLS, so admin needs explicit SELECT permission).';

-- ─── Bug 23.4 — crm_leads admin-only ─────────────────────────────────────
CREATE POLICY crm_leads_admin_all ON public.crm_leads
  FOR ALL TO authenticated
  USING (public.is_admin_user((SELECT auth.uid())))
  WITH CHECK (public.is_admin_user((SELECT auth.uid())));

COMMENT ON POLICY crm_leads_admin_all ON public.crm_leads IS
  'Pass 23 Bug 23.4: admin-only read/write. Lead intake (public capture form, signup webhooks) writes via service_role (bypasses RLS).';
