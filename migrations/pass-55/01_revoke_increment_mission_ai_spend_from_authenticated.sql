-- Pass 55 - increment_mission_ai_spend is executable by any signed-in user.
--
-- NOT APPLIED. Held for owner approval.
--
-- WHAT IS TRUE ON PRODUCTION RIGHT NOW
--   SELECT proacl FROM pg_proc WHERE proname = 'increment_mission_ai_spend';
--   -> postgres=X/postgres , authenticated=X/postgres , service_role=X/postgres
--
-- The function is SECURITY DEFINER, takes (p_mission_id uuid, p_cost numeric),
-- and adds p_cost to ai_cost_usd and ai_spend_usd_actual on the mission row it
-- is handed. It performs no ownership check and no sign check, and PostgREST
-- exposes every function in `public` that the caller may execute. So any
-- account that can sign up can call it against any mission id.
--
-- WHY THAT IS NOT MERELY UNTIDY
-- src/services/ai/recruitLoop.js re-reads ai_spend_usd_actual from the row on
-- every iteration and compares it to ai_spend_ceiling_usd (see the loop around
-- lines 244-269). Inflating that column on a stranger's in-flight mission ends
-- their run early. The product's stated policy is NO REFUNDS on a ceiling-hit
-- run: the mission still completes and the customer is shown "X of Y
-- qualified". So the attack turns someone else's paid study into a partial
-- delivery they cannot claim back. A negative p_cost is the same lever pulled
-- the other way - the caller's own ceiling stops binding.
--
-- HOW IT HAPPENED
-- migrations/pass-42/02_a3 created the function and granted it to
-- `authenticated` alongside `service_role`. Its sibling
-- increment_mission_ai_cost had already been locked down the right way in
-- migrations/pass-22/02 (REVOKE ... FROM PUBLIC, anon, authenticated). The
-- pass-42 grant line simply did not copy that. The two functions write the
-- same two columns and should have the same ACL.
--
-- WHY THIS IS SAFE TO APPLY
-- The only caller in either repo is src/services/ai/anthropic.js:136, which
-- runs on the backend under the service_role key. `service_role` keeps its
-- grant here, and additionally has rolbypassrls = true. Nothing in the
-- frontend calls this function at all:
--   grep -rn increment_mission_ai_spend  ->  backend src/services/ai/anthropic.js,
--                                            test/, migrations/.  Frontend: none.
--
-- Verification after applying:
--   SELECT proname, proacl FROM pg_proc
--    WHERE proname IN ('increment_mission_ai_spend','increment_mission_ai_cost');
--   -- both should list service_role and postgres only.
--
-- Positive control that the lockdown actually bites: mint a normal signed-in
-- session and POST to /rest/v1/rpc/increment_mission_ai_spend. Before: 200 and
-- the column moves. After: 42501 permission denied, and the column does not.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.increment_mission_ai_spend(uuid, numeric)
--     TO authenticated;

BEGIN;

REVOKE EXECUTE ON FUNCTION public.increment_mission_ai_spend(uuid, numeric)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.increment_mission_ai_spend(uuid, numeric)
  TO service_role;

COMMIT;
