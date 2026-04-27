-- Pass 22 Batch 2 — Funnel telemetry overhaul (Bugs 22.1, 22.2, 22.3, 22.4).
--
-- See migration 06 for the doctrine. This file is the audit-trail snapshot of
-- pass_22_b2_funnel_session_index_and_micro_funnel_rpcs (applied live).

CREATE INDEX IF NOT EXISTS idx_funnel_events_session_id
  ON public.funnel_events (session_id)
  WHERE session_id IS NOT NULL;

-- Bug 22.3 — session-level conversion (landing → signup)
CREATE OR REPLACE FUNCTION public.admin_session_funnel(
  range_start timestamptz,
  range_end   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
BEGIN
  WITH sessions AS (
    SELECT DISTINCT session_id
    FROM public.funnel_events
    WHERE event_type = 'landing_view'
      AND session_id IS NOT NULL
      AND created_at >= range_start AND created_at < range_end
  ),
  with_signup AS (
    SELECT COUNT(DISTINCT s.session_id)::bigint AS n
    FROM sessions s
    JOIN public.funnel_events fe
      ON fe.session_id = s.session_id
     AND fe.event_type = 'signup_completed'
     AND fe.created_at >= range_start AND fe.created_at < range_end
  ),
  total AS (SELECT COUNT(*)::bigint AS n FROM sessions)
  SELECT jsonb_build_object(
    'landing_view_sessions',     (SELECT n FROM total),
    'sessions_with_signup',      (SELECT n FROM with_signup),
    'conversion_pct',
      CASE WHEN (SELECT n FROM total) > 0
        THEN ROUND(100.0 * (SELECT n FROM with_signup) / (SELECT n FROM total), 1)
        ELSE 0
      END
  ) INTO result;
  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_session_funnel(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- Bug 22.2 — stage-to-stage micro-funnel
CREATE OR REPLACE FUNCTION public.admin_micro_funnel(
  range_start timestamptz,
  range_end   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'landing_view',           (SELECT COUNT(DISTINCT COALESCE(user_id::text, session_id)) FROM public.funnel_events
                               WHERE event_type='landing_view' AND created_at >= range_start AND created_at < range_end),
    'signup_completed',       (SELECT COUNT(DISTINCT user_id) FROM public.funnel_events
                               WHERE event_type='signup_completed' AND created_at >= range_start AND created_at < range_end),
    'mission_setup_started',  (SELECT COUNT(DISTINCT user_id) FROM public.funnel_events
                               WHERE event_type='mission_setup_started' AND created_at >= range_start AND created_at < range_end),
    'checkout_opened',        (SELECT COUNT(DISTINCT user_id) FROM public.funnel_events
                               WHERE event_type='checkout_opened' AND created_at >= range_start AND created_at < range_end),
    'mission_paid',           (SELECT COUNT(DISTINCT user_id) FROM public.funnel_events
                               WHERE event_type='mission_paid' AND created_at >= range_start AND created_at < range_end),
    'mission_completed',      (SELECT COUNT(DISTINCT user_id) FROM public.funnel_events
                               WHERE event_type='mission_completed' AND created_at >= range_start AND created_at < range_end)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_micro_funnel(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.admin_session_funnel(timestamptz, timestamptz) IS
  'Pass 22 Bug 22.3 — landing-view session → signup conversion rate. service_role only (Bug 22.6 lockdown).';
COMMENT ON FUNCTION public.admin_micro_funnel(timestamptz, timestamptz) IS
  'Pass 22 Bug 22.2 — stage-to-stage micro-funnel counts (DISTINCT user_id per stage). service_role only (Bug 22.6 lockdown).';
