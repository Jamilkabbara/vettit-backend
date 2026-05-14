-- Pass 42 A3 — atomic increment of both ai_cost_usd and ai_spend_usd_actual
-- on every Anthropic API call. Apply via Supabase MCP `apply_migration`
-- as `pass_42_a3_increment_mission_ai_spend_rpc`.
--
-- Background: Pass 42 A1 added ai_spend_usd_actual as the column the
-- recruit-loop reads to decide when to terminate. Pre-Pass-42 code
-- writes to ai_cost_usd via the increment_mission_ai_cost(uuid, numeric)
-- RPC defined in an earlier pass (no full definition in migrations/—
-- it's a SECURITY DEFINER function admin'd outside this repo).
--
-- Rather than risk dropping/recreating that RPC, this migration adds
-- a NEW function increment_mission_ai_spend(uuid, numeric) that writes
-- BOTH columns atomically. anthropic.js calls the new one. The old
-- one stays callable for anything still using it.

CREATE OR REPLACE FUNCTION public.increment_mission_ai_spend(
  p_mission_id uuid,
  p_cost numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Atomic UPDATE — single statement, no read-modify-write race.
  UPDATE public.missions
     SET ai_cost_usd          = COALESCE(ai_cost_usd, 0)          + p_cost,
         ai_spend_usd_actual  = COALESCE(ai_spend_usd_actual, 0)  + p_cost
   WHERE id = p_mission_id;
END;
$$;

-- Lock down: only service_role + authenticated callers via SECURITY
-- DEFINER. Anon must never call this.
REVOKE EXECUTE ON FUNCTION public.increment_mission_ai_spend(uuid, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.increment_mission_ai_spend(uuid, numeric) TO authenticated, service_role;

-- ─── verification ────────────────────────────────────────────────────
-- Manual smoke test from psql:
--   SELECT id, ai_cost_usd, ai_spend_usd_actual FROM missions LIMIT 1;
--   SELECT increment_mission_ai_spend('<uuid>'::uuid, 0.05);
--   SELECT id, ai_cost_usd, ai_spend_usd_actual FROM missions WHERE id = '<uuid>';
--   -- both columns should have advanced by 0.05
