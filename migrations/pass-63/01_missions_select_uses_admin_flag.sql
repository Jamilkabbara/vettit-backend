-- pass-63: admin access is a property of the account, not a string in a policy.
--
-- missions_select granted read to a hardcoded email literal
-- ('kabbarajamil@gmail.com'). Three problems: it trusts an email claim in the
-- JWT rather than an account property, it silently grants everything to
-- whoever holds that address if it is ever changed or re-registered, and it
-- diverges from every other admin check here, which all use is_admin_user().
--
-- Verified before applying, in a rolled-back transaction: the owner sees 100
-- missions under both old and new policy, and under the new one their JWT does
-- not need to carry an email at all; a customer sees only their own 2 either
-- way. Exactly one profile has is_admin = true, and it is the owner's.
--
-- Applied 2026-09-21.

DROP POLICY IF EXISTS missions_select ON public.missions;

CREATE POLICY missions_select ON public.missions
  FOR SELECT
  USING (
    (SELECT auth.uid()) = user_id
    OR public.is_admin_user((SELECT auth.uid()))
  );
