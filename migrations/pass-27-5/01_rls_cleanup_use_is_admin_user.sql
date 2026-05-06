-- Pass 27.5 A — RLS cleanup: vendor_costs uses is_admin_user(auth.uid()).
-- Applied via apply_migration as pass_27_5_a_rls_cleanup_use_is_admin_user.
--
-- Pre-flight verified before running:
--   1. public.is_admin_user(uid uuid) -> boolean exists with expected
--      signature (reads profiles.is_admin).
--   2. Jamil's profile (82405ff9-…) has is_admin = true. No lockout risk.
--   3. pg_policies sweep: only the 2 vendor_costs policies hardcoded the
--      UUID. No other tables affected.
-- Post-migration sweep returned 0 remaining policies with the UUID.
--
-- GitGuardian "Generic High Entropy Secret" alert on the original
-- Pass 24 Bug 24.02 migration was a false positive (UUIDs aren't
-- credentials) but this rewrite removes the trigger pattern and lets
-- future admin onboarding flip profiles.is_admin instead of editing
-- RLS policies.

DROP POLICY IF EXISTS "vendor_costs_admin_read" ON vendor_costs;
DROP POLICY IF EXISTS "vendor_costs_admin_write" ON vendor_costs;

CREATE POLICY "vendor_costs_admin_read" ON vendor_costs
  FOR SELECT TO authenticated
  USING (public.is_admin_user(auth.uid()));

CREATE POLICY "vendor_costs_admin_write" ON vendor_costs
  FOR ALL TO authenticated
  USING (public.is_admin_user(auth.uid()))
  WITH CHECK (public.is_admin_user(auth.uid()));
