-- Pass 22 Bug 22.10 + 22.12 — performance indexes + RLS optimization + cron lock table.
--
-- Forensic (mcp_supabase_get_advisors performance, pre-migration):
--   * 9 unindexed FKs (covering indexes added below)
--   * 5 RLS policies still use bare auth.uid() (rewritten to (SELECT auth.uid()))
--   * 19 multiple-permissive WARN on blog_posts (3 overlapping policies; consolidated)
--   * 2 multiple-permissive WARN on promo_codes (2 deny policies; default-deny replaces)
--   * 1 multiple-permissive WARN on payment_errors (consolidated)
--   * 1 duplicate index: blog_posts_slug_unique vs blog_posts_slug_key (dropped duplicate)
--
-- Out of scope (deferred to Bug 22.12b): drop unused indexes. Master prompt warned
-- that "unused" can mean "not yet exercised by a feature that hasn't fired yet"
-- (e.g., idx_profiles_is_admin is referenced by Bug 22.6 RLS expressions).
--
-- Bug 22.10 piece: cron_locks table for distributed-instance safety. Used by
-- src/jobs/missionRecovery.js to skip a tick if another Railway instance is
-- already running the job. Stale lock (>15min old) is auto-stolen.
--
-- Verification:
--   * advisor performance run after migration:
--       0 unindexed_foreign_keys (was 9)
--       0 auth_rls_initplan WARN (was 5)
--       0 multiple_permissive_policies WARN (was 22 across blog_posts/promo_codes/payment_errors)
--       0 duplicate_index WARN
--   * unused_index INFO grew from 7 → 18 (the 9 newly-created FK indexes plus
--     the 2 from Bug 22.9 — expected; will be exercised by traffic and revisited
--     in Bug 22.12b).

-- ─── 1. Cover unindexed foreign keys ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id     ON public.chat_sessions   (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_mission_id  ON public.chat_sessions   (mission_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_user_id     ON public.funnel_events   (user_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_mission_id  ON public.funnel_events   (mission_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_author_id      ON public.blog_posts      (author_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id   ON public.support_tickets (user_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_user_id         ON public.crm_leads       (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_notes_admin_id ON public.admin_user_notes(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_mission_id   ON public.admin_alerts    (mission_id);

-- ─── 2. Drop duplicate blog_posts.slug index ─────────────────────────────
DROP INDEX IF EXISTS public.blog_posts_slug_unique;

-- ─── 3. Rewrite 5 RLS policies to use (SELECT auth.uid()) initplan form ─
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
  ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles
  FOR UPDATE TO authenticated
  USING      ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS admin_read_all_funnel ON public.funnel_events;
CREATE POLICY admin_read_all_funnel
  ON public.funnel_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.is_admin = true
  ));

DROP POLICY IF EXISTS user_insert_own_funnel ON public.funnel_events;
CREATE POLICY user_insert_own_funnel
  ON public.funnel_events
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS admin_only_notes ON public.admin_user_notes;
CREATE POLICY admin_only_notes
  ON public.admin_user_notes
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.is_admin = true
  ));

-- ─── 4. Consolidate blog_posts policies (3 → 2) ──────────────────────────
DROP POLICY IF EXISTS blog_posts_admin_all     ON public.blog_posts;
DROP POLICY IF EXISTS blog_posts_author_own    ON public.blog_posts;
DROP POLICY IF EXISTS blog_posts_public_read   ON public.blog_posts;

CREATE POLICY blog_posts_anon_published_read
  ON public.blog_posts
  FOR SELECT TO anon
  USING (published = true);

CREATE POLICY blog_posts_authenticated_full
  ON public.blog_posts
  FOR ALL TO authenticated
  USING (
    published = true
    OR author_id = (SELECT auth.uid())
    OR public.is_admin_user((SELECT auth.uid()))
  )
  WITH CHECK (
    public.is_admin_user((SELECT auth.uid()))
    OR author_id = (SELECT auth.uid())
  );

-- ─── 5. Consolidate payment_errors SELECT policies (2 → 1) ───────────────
DROP POLICY IF EXISTS payment_errors_admin_select    ON public.payment_errors;
DROP POLICY IF EXISTS payment_errors_user_own_select ON public.payment_errors;

CREATE POLICY payment_errors_authenticated_select
  ON public.payment_errors
  FOR SELECT TO authenticated
  USING (
    public.is_admin_user((SELECT auth.uid()))
    OR user_id = (SELECT auth.uid())
  );

-- ─── 6. promo_codes: drop both deny policies; rely on default-deny ───────
DROP POLICY IF EXISTS "Deny all client reads of promo_codes"  ON public.promo_codes;
DROP POLICY IF EXISTS "Deny all client writes of promo_codes" ON public.promo_codes;

-- ─── 7. cron_locks table — Bug 22.10 distributed-instance safety ─────────
CREATE TABLE IF NOT EXISTS public.cron_locks (
  job_name     text PRIMARY KEY,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  acquired_by  text         NOT NULL
);

ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cron_locks IS
  'Distributed cron deduplication. Bug 22.10 missionRecovery worker uses INSERT...ON CONFLICT to claim per-job locks. service_role only; no RLS policies (default-deny for client roles). (Pass 22 Bug 22.10)';
