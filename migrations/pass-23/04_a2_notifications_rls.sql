-- =============================================================================
-- Pass 23 A2 (Bug 23.11) — RLS on notifications.
--
-- Pre-existing state: a `users_own_notif` policy already exists (FOR ALL TO
-- authenticated USING auth.uid() = user_id). Multi-permissive policies on
-- the same commands trigger Supabase advisor performance warnings, so this
-- migration just enables RLS (idempotent — already on) and confirms the
-- policy state. The accidental duplicate policies created earlier
-- (notifications_user_own_select, notifications_user_own_update) were
-- dropped via pass_23_a2_notifications_rls_dedup.
--
-- The frontend NotificationBell rewrite reads + writes via the supabase
-- anon client; users_own_notif scopes both SELECT (the bell list) and
-- UPDATE (mark-as-read) to the authenticated user's own rows. Realtime
-- subscriptions on the notifications channel will respect this policy.
--
-- INSERT remains service_role-only — runMission.js / webhooks.js write
-- via the supabase service-role client which bypasses RLS by design.
-- =============================================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Idempotent: if you ever drop users_own_notif accidentally, this restores
-- the canonical policy. Safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public'
       AND tablename='notifications'
       AND policyname='users_own_notif'
  ) THEN
    EXECUTE $body$
      CREATE POLICY users_own_notif ON notifications
        FOR ALL TO authenticated
        USING ((SELECT auth.uid()) = user_id);
    $body$;
  END IF;
END $$;

DO $$
DECLARE
  pol_count int;
BEGIN
  SELECT COUNT(*) INTO pol_count
    FROM pg_policies
    WHERE schemaname='public' AND tablename='notifications';
  RAISE NOTICE 'Pass 23 A2 RLS: % policies on notifications (expect 1: users_own_notif)', pol_count;
END $$;
