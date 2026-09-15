-- Pass 59: every admin revenue figure is net of Stripe refunds.
--
-- One rule, public.mission_net_revenue_cents(missions), mirrored exactly by
-- src/services/payments/netRevenue.js. Revenue is what Stripe captured minus
-- what Stripe refunded, and only for missions Stripe charged. Admin overrides,
-- 100%-off promos and rows marked paid with no charge are $0 of revenue.
--
-- Before this, the four RPCs below summed missions.total_price_usd over
-- status paid/completed: list prices, including 11 admin-override missions
-- never charged ($849) and 21 fully refunded charges ($365.60). The status
-- filter is dropped: a paid mission that failed was still paid for, and its
-- refund is what zeroes it.
--
-- Return types are unchanged, so no caller changes shape.

CREATE OR REPLACE FUNCTION public.mission_net_revenue_cents(m public.missions)
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN m.paid_at IS NOT NULL
     AND (m.latest_payment_intent_id IS NOT NULL
          OR m.checkout_session_id IS NOT NULL
          OR cardinality(m.stripe_refund_ids) > 0)
    THEN GREATEST(COALESCE(m.paid_amount_cents, 0) - m.refunded_amount_cents, 0)
    ELSE 0
  END
$fn$;
-- A row-typed function is exposed by PostgREST as a computed column; only the
-- server needs it.
REVOKE ALL ON FUNCTION public.mission_net_revenue_cents(public.missions) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mission_net_revenue_cents(public.missions) TO service_role;

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
  -- Pass 59: revenue is net of Stripe refunds (mission_net_revenue_cents).
  SELECT jsonb_build_object(
    'total_ai_cost_usd', COALESCE(SUM(ac.cost_usd), 0),
    'total_revenue_usd', COALESCE((
      SELECT ROUND(SUM(public.mission_net_revenue_cents(m)) / 100.0, 2) FROM missions m
      WHERE m.paid_at >= range_start AND m.paid_at < range_end
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

CREATE OR REPLACE FUNCTION public.daily_revenue_buckets(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS TABLE(bucket_date date, revenue_usd numeric, mission_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Revenue and the day series only. Cost is read from ai_calls by the caller.
  -- Pass 59: revenue is net of Stripe refunds; mission_count is paid missions.
  RETURN QUERY
  WITH days AS (
    SELECT generate_series(range_start::date, range_end::date, '1 day'::interval)::date AS d
  )
  SELECT
    d.d,
    COALESCE(ROUND(SUM(public.mission_net_revenue_cents(m)) / 100.0, 2), 0::numeric),
    COUNT(m.id)::bigint
  FROM days d
  LEFT JOIN missions m ON m.paid_at::date = d.d
  GROUP BY d.d
  ORDER BY d.d;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_user_segments()
 RETURNS TABLE(segment text, user_count bigint, avg_ltv numeric, total_ltv numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 59: spent (lifetime value) is net of Stripe refunds.
  RETURN QUERY
  WITH user_stats AS (
    SELECT p.id AS uid,
           COUNT(m.id) AS missions,
           COUNT(m.id) FILTER (WHERE m.status IN ('paid','completed')) AS paid_missions,
           COALESCE(SUM(public.mission_net_revenue_cents(m)) FILTER (WHERE m.id IS NOT NULL), 0) / 100.0 AS spent
    FROM profiles p LEFT JOIN missions m ON m.user_id = p.id
    GROUP BY p.id
  ), bucketed AS (
    SELECT CASE WHEN paid_missions >= 5 THEN 'Power users'
                WHEN paid_missions BETWEEN 1 AND 4 THEN 'Active users'
                WHEN missions > 0 THEN 'Trial users'
                ELSE 'Signed up only' END AS seg,
           uid, spent
    FROM user_stats
  )
  SELECT b.seg, COUNT(*)::bigint, ROUND(AVG(b.spent)::numeric, 2), ROUND(SUM(b.spent)::numeric, 2)
  FROM bucketed b
  GROUP BY b.seg
  ORDER BY CASE b.seg WHEN 'Power users' THEN 1 WHEN 'Active users' THEN 2 WHEN 'Trial users' THEN 3 WHEN 'Signed up only' THEN 4 END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_activity_feed(row_limit integer DEFAULT 20)
 RETURNS TABLE(event_type text, event_icon text, title text, meta text, amount_usd numeric, occurred_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Pass 22 Bug 22.6: gated by EXECUTE matrix + adminOnly middleware.
  -- Pass 59: amount is what VETT kept from the mission, net of refunds.
  RETURN QUERY
  SELECT * FROM (
    (SELECT
       'mission_completed'::text,
       '✅'::text,
       ('Mission: ' || COALESCE(m.title, 'untitled'))::text,
       m.user_id::text,
       ROUND(public.mission_net_revenue_cents(m) / 100.0, 2),
       m.completed_at
     FROM missions m WHERE m.completed_at IS NOT NULL
     ORDER BY m.completed_at DESC LIMIT row_limit)
    UNION ALL
    (SELECT
       'payment_received'::text,
       '💳'::text,
       ('Payment: ' || COALESCE(m.title, 'untitled'))::text,
       m.user_id::text,
       ROUND(public.mission_net_revenue_cents(m) / 100.0, 2),
       m.paid_at
     FROM missions m
     WHERE m.paid_at IS NOT NULL AND m.completed_at IS NULL
     ORDER BY m.paid_at DESC LIMIT row_limit)
  ) combined
  ORDER BY occurred_at DESC NULLS LAST
  LIMIT row_limit;
END;
$function$;
