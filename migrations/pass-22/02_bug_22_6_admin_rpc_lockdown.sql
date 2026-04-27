-- Pass 22 Bug 22.6 — Admin RPC lockdown.
--
-- Forensic: Supabase advisor flagged 11 SECURITY DEFINER functions in the
-- public schema as REST-callable by anon and authenticated. Each of the 8
-- admin_* / daily_revenue_buckets functions had an in-body guard
--   IF NOT is_admin_user(auth.uid()) THEN RAISE EXCEPTION '...'; END IF;
-- which gated data return. But anyone authenticated could still execute
-- the function via REST and incur Postgres compute. After Bug 22.5 closed
-- the RLS holes, this was the largest remaining surface.
--
-- Strategy:
--   1) Drop the in-body is_admin_user(auth.uid()) guard from the 8 admin
--      RPCs. The route at /api/admin/* is gated by authenticate +
--      adminOnly middleware (admin.js:10), and EXECUTE is now revoked
--      from PUBLIC/anon/authenticated, so service_role from the backend
--      is the sole caller path.
--   2) REVOKE EXECUTE on 10 functions from PUBLIC, anon, authenticated.
--      Backend admin.js Bug 22.6 pre-step (commit 4b18e87) refactored
--      every admin RPC call site to use the global service_role
--      singleton.
--   3) is_admin_user(uuid) is REVOKED from PUBLIC and anon ONLY —
--      authenticated retains EXECUTE because Bug 22.5's RLS policies on
--      stripe_webhook_events / admin_alerts / payment_errors plus
--      pre-existing policies on funnel_events / admin_user_notes call it
--      from authenticated context for client-side own-row reads.
--
-- Advisor end state after migration + backend merge:
--   * 21 SECURITY DEFINER WARN entries drop
--   * 1 WARN remains intentionally:
--       authenticated_security_definer_function_executable for
--       is_admin_user(uuid) — required by RLS expression evaluation,
--       returns only a boolean (no admin data leak).
--   * 0 ERROR-level entries.
--
-- Verification (live, post-apply):
--   * pg_proc.proacl: 10 functions show only postgres + service_role;
--     is_admin_user shows postgres + service_role + authenticated.
--   * curl POST /rest/v1/rpc/admin_funnel with anon key → 42501
--     "permission denied for function admin_funnel".
--   * curl POST /rest/v1/rpc/admin_user_segments with anon key → 42501.
--   * mcp_supabase_get_advisors security: 1 intentional WARN remains.

-- ─── 1. Drop the in-body is_admin_user guard from 8 admin RPCs ───────────

CREATE OR REPLACE FUNCTION public.admin_activity_feed(row_limit integer DEFAULT 20)
 RETURNS TABLE(event_type text, event_icon text, title text, meta text, amount_usd numeric, occurred_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body is_admin_user(auth.uid()) guard removed.
  -- EXECUTE permission is revoked from PUBLIC/anon/authenticated; only
  -- service_role can call this function. The /api/admin/* route is
  -- gated by authenticate + adminOnly middleware in admin.js.
  RETURN QUERY
  SELECT * FROM (
    (SELECT
       'mission_completed'::text,
       '✅'::text,
       ('Mission: ' || COALESCE(m.title, 'untitled'))::text,
       m.user_id::text,
       m.total_price_usd,
       m.completed_at
     FROM missions m WHERE m.completed_at IS NOT NULL
     ORDER BY m.completed_at DESC LIMIT row_limit)
    UNION ALL
    (SELECT
       'payment_received'::text,
       '💳'::text,
       ('Payment: ' || COALESCE(m.title, 'untitled'))::text,
       m.user_id::text,
       m.total_price_usd,
       m.paid_at
     FROM missions m
     WHERE m.paid_at IS NOT NULL AND m.completed_at IS NULL
     ORDER BY m.paid_at DESC LIMIT row_limit)
  ) combined
  ORDER BY occurred_at DESC NULLS LAST
  LIMIT row_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_ai_cost_by_operation(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS TABLE(call_type text, total_cost_usd numeric, total_calls bigint, avg_cost_per_call numeric, total_input_tokens bigint, total_output_tokens bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN QUERY
  SELECT
    ac.call_type,
    ROUND(SUM(ac.cost_usd)::numeric, 4),
    COUNT(*)::bigint,
    ROUND((SUM(ac.cost_usd) / NULLIF(COUNT(*), 0))::numeric, 6),
    SUM(ac.input_tokens)::bigint,
    SUM(ac.output_tokens)::bigint
  FROM ai_calls ac
  WHERE ac.created_at >= range_start AND ac.created_at < range_end
  GROUP BY ac.call_type
  ORDER BY SUM(ac.cost_usd) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_ai_cost_summary(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result JSONB;
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  SELECT jsonb_build_object(
    'total_ai_cost_usd', COALESCE(SUM(ac.cost_usd), 0),
    'total_revenue_usd', COALESCE((
      SELECT SUM(total_price_usd) FROM missions
      WHERE paid_at >= range_start AND paid_at < range_end AND status IN ('paid','completed')
    ), 0),
    'total_calls', COUNT(ac.id),
    'total_input_tokens', COALESCE(SUM(ac.input_tokens), 0),
    'total_output_tokens', COALESCE(SUM(ac.output_tokens), 0),
    'avg_latency_ms', COALESCE(ROUND(AVG(ac.latency_ms)), 0),
    'failed_calls', COUNT(ac.id) FILTER (WHERE ac.success = false)
  ) INTO result
  FROM ai_calls ac
  WHERE ac.created_at >= range_start AND ac.created_at < range_end;

  result = result || jsonb_build_object(
    'gross_margin_usd',
      (result->>'total_revenue_usd')::numeric - (result->>'total_ai_cost_usd')::numeric,
    'gross_margin_pct',
      CASE WHEN (result->>'total_revenue_usd')::numeric > 0
        THEN ROUND(100.0 * (1.0 - (result->>'total_ai_cost_usd')::numeric
             / (result->>'total_revenue_usd')::numeric), 2)
        ELSE 0
      END,
    'avg_cost_per_mission',
      CASE WHEN (result->>'total_calls')::numeric > 0
        THEN ROUND((result->>'total_ai_cost_usd')::numeric / (result->>'total_calls')::numeric, 4)
        ELSE 0
      END,
    'tiering_savings_usd', 0
  );

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_ai_model_mix(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS TABLE(model text, call_count bigint, percentage numeric, total_cost_usd numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN QUERY
  WITH total AS (
    SELECT COUNT(*) AS n FROM ai_calls
    WHERE created_at >= range_start AND created_at < range_end
  )
  SELECT
    ac.model,
    COUNT(*)::bigint,
    ROUND(100.0 * COUNT(*) / NULLIF((SELECT n FROM total), 0), 1),
    ROUND(SUM(ac.cost_usd)::numeric, 4)
  FROM ai_calls ac
  WHERE ac.created_at >= range_start AND ac.created_at < range_end
  GROUP BY ac.model
  ORDER BY COUNT(*) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_funnel(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN jsonb_build_object(
    'landing_views', (
      SELECT COUNT(*) FROM funnel_events
      WHERE event_type IN ('landing_view')
        AND created_at >= range_start AND created_at < range_end
    ),
    'signups', (
      SELECT COUNT(DISTINCT id) FROM auth.users
      WHERE created_at >= range_start AND created_at < range_end
    ),
    'setup_started', (
      -- Pass 21 Bug 4: derive from missions. Every mission row implies a
      -- setup was started, regardless of whether the frontend emitted the
      -- mission_setup_started event (which forensically fires for ~8% of
      -- setups). This makes the funnel monotonic: setup_started >=
      -- payment_reached >= paid >= completed.
      SELECT COUNT(*) FROM missions
      WHERE created_at >= range_start AND created_at < range_end
    ),
    'payment_reached', (
      SELECT COUNT(*) FROM missions
      WHERE status IN ('pending_payment','paid','completed')
        AND COALESCE(paid_at, created_at) >= range_start
        AND COALESCE(paid_at, created_at) <  range_end
    ),
    'paid', (
      SELECT COUNT(*) FROM missions
      WHERE status IN ('paid','completed')
        AND paid_at >= range_start AND paid_at < range_end
    ),
    'completed', (
      SELECT COUNT(*) FROM missions
      WHERE status = 'completed'
        AND completed_at >= range_start AND completed_at < range_end
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_mission_margins(range_start timestamp with time zone, range_end timestamp with time zone, row_limit integer DEFAULT 50)
 RETURNS TABLE(mission_id uuid, title text, respondent_count integer, price_usd numeric, ai_cost_usd numeric, net_margin_usd numeric, margin_pct numeric, paid_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN QUERY
  SELECT
    m.id,
    m.title,
    m.respondent_count,
    m.total_price_usd,
    COALESCE(m.ai_cost_usd, 0::numeric),
    m.total_price_usd - COALESCE(m.ai_cost_usd, 0::numeric),
    CASE WHEN m.total_price_usd > 0
      THEN ROUND(100.0 * (m.total_price_usd - COALESCE(m.ai_cost_usd, 0::numeric)) / m.total_price_usd, 2)
      ELSE 0::numeric
    END,
    m.paid_at
  FROM missions m
  WHERE m.paid_at >= range_start AND m.paid_at < range_end
    AND m.status IN ('paid','completed')
  ORDER BY
    (m.total_price_usd - COALESCE(m.ai_cost_usd, 0::numeric))
    / NULLIF(m.total_price_usd, 0) ASC NULLS LAST
  LIMIT row_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_user_segments()
 RETURNS TABLE(segment text, user_count bigint, avg_ltv numeric, total_ltv numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN QUERY
  WITH user_stats AS (
    SELECT
      COALESCE(p.role, 'Unknown') AS seg,
      p.id AS uid,
      COALESCE(SUM(m.total_price_usd), 0::numeric) AS spent
    FROM profiles p
    LEFT JOIN missions m ON m.user_id = p.id AND m.status IN ('paid','completed')
    GROUP BY p.role, p.id
  )
  SELECT
    us.seg,
    COUNT(*)::bigint,
    ROUND(AVG(us.spent)::numeric, 2),
    ROUND(SUM(us.spent)::numeric, 2)
  FROM user_stats us
  GROUP BY us.seg
  ORDER BY SUM(us.spent) DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.daily_revenue_buckets(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS TABLE(bucket_date date, revenue_usd numeric, ai_cost_usd numeric, mission_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: in-body guard removed; gated by EXECUTE matrix + adminOnly middleware.
  RETURN QUERY
  WITH days AS (
    SELECT generate_series(
      range_start::date,
      range_end::date,
      '1 day'::interval
    )::date AS d
  )
  SELECT
    d.d,
    COALESCE(SUM(m.total_price_usd), 0::numeric),
    COALESCE(SUM(m.ai_cost_usd), 0::numeric),
    COUNT(m.id)::bigint
  FROM days d
  LEFT JOIN missions m ON m.paid_at::date = d.d AND m.status IN ('paid','completed')
  GROUP BY d.d
  ORDER BY d.d;
END;
$function$;

-- ─── 2. REVOKE EXECUTE per matrix ────────────────────────────────────────

-- 8 admin RPCs: remove from PUBLIC, anon, authenticated.
REVOKE EXECUTE ON FUNCTION public.admin_activity_feed(integer)             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_ai_cost_by_operation(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_ai_cost_summary(timestamptz, timestamptz)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_ai_model_mix(timestamptz, timestamptz)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_funnel(timestamptz, timestamptz)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_mission_margins(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_user_segments()                                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.daily_revenue_buckets(timestamptz, timestamptz)       FROM PUBLIC, anon, authenticated;

-- handle_new_user is an auth trigger; never callable via REST in normal
-- flow. The trigger fires as the table owner (postgres) regardless of
-- caller role, so revoking REST EXECUTE has no effect on the trigger path.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- increment_mission_ai_cost is called from src/services/ai/anthropic.js
-- via the global service-role singleton. No JWT-bearing caller path.
REVOKE EXECUTE ON FUNCTION public.increment_mission_ai_cost(uuid, numeric) FROM PUBLIC, anon, authenticated;

-- is_admin_user(uuid) — REVOKE from PUBLIC and anon ONLY. Authenticated
-- retains EXECUTE because the function is referenced from RLS policy
-- expressions on:
--   * stripe_webhook_events, admin_alerts, payment_errors  (Pass 22 Bug 22.5)
--   * funnel_events, admin_user_notes                       (pre-existing)
-- Revoking from authenticated would silently break those policies with
-- "permission denied for function is_admin_user" on every authenticated
-- read of the affected tables. The function returns only a boolean, so
-- exposure to authenticated callers is acceptable.
REVOKE EXECUTE ON FUNCTION public.is_admin_user(uuid) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.is_admin_user(uuid) IS
  'Boolean admin check. Pass 22 Bug 22.6: EXECUTE retained for authenticated role (used by RLS expressions on funnel_events, admin_user_notes, stripe_webhook_events, admin_alerts, payment_errors). The advisor WARN authenticated_security_definer_function_executable for this function is INTENTIONAL.';
