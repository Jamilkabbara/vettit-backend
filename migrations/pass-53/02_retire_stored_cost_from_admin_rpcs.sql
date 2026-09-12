-- Pass 53/02 - take the stored AI cost column out of the two admin RPCs.
--
-- APPLIED TO PRODUCTION 2026-09-13 as migration
-- pass53_02_retire_stored_cost_from_admin_rpcs. This file is the repo's record
-- of it, not a pending change.
--
-- WHY
-- missions.ai_cost_usd is a denormalised running sum that has been wrong three
-- separate times. ai_calls is the record of truth. PR #165 moved every admin
-- spend figure onto ai_calls in the route layer, which left these two functions
-- still holding the wrong source while nothing trusted them for it any more.
--
-- VERIFIED BEFORE APPLYING
--   admin_mission_margins  no caller anywhere in either repo. The only hits
--                          were its own definition, two comments and one doc
--                          in the frontend. Dropped outright.
--   daily_revenue_buckets  STILL CALLED at src/routes/admin.js:1424, but the
--                          route reads only bucket_date and revenue_usd. Its
--                          ai_cost_usd column was dead; the route now takes
--                          per-day cost from ai_calls so the chart and the
--                          headline above it cannot disagree. Column removed,
--                          function kept.
--
-- A RETURNS TABLE signature cannot be altered by CREATE OR REPLACE, so
-- daily_revenue_buckets is dropped and recreated. The security posture was read
-- out of pg_proc first and reproduced exactly: SECURITY DEFINER,
-- search_path=public, EXECUTE to service_role only, never to PUBLIC, anon or
-- authenticated.
--
-- PROOF CAPTURED EITHER SIDE OF THE CHANGE
-- Same call, same window, before and after: revenue_usd and mission_count
-- identical for every bucket (for example 2026-06-13 = $840.00 across 10
-- missions). Only the ai_cost_usd column disappeared.
--
-- ROLLBACK
-- Recreate both from migrations/pass-22/02_bug_22_6_admin_rpc_lockdown.sql,
-- which still carries the original definitions and the REVOKE matrix.

DROP FUNCTION IF EXISTS public.admin_mission_margins(timestamptz, timestamptz, integer);

DROP FUNCTION IF EXISTS public.daily_revenue_buckets(timestamptz, timestamptz);

CREATE FUNCTION public.daily_revenue_buckets(
  range_start timestamp with time zone,
  range_end   timestamp with time zone
)
RETURNS TABLE(bucket_date date, revenue_usd numeric, mission_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Revenue and the day series only. Returning a second, stored cost figure
  -- here is what let the daily chart draw a different, flattering cost line
  -- from the same response the headline gross profit came from.
  RETURN QUERY
  WITH days AS (
    SELECT generate_series(range_start::date, range_end::date, '1 day'::interval)::date AS d
  )
  SELECT
    d.d,
    COALESCE(SUM(m.total_price_usd), 0::numeric),
    COUNT(m.id)::bigint
  FROM days d
  LEFT JOIN missions m ON m.paid_at::date = d.d AND m.status IN ('paid','completed')
  GROUP BY d.d
  ORDER BY d.d;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.daily_revenue_buckets(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.daily_revenue_buckets(timestamptz, timestamptz) TO service_role;
