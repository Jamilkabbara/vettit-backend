-- Pass 21 Bug 2: admin_funnel.signups should count distinct auth.users
-- created in the range, not mission rows.
--
-- Before: SELECT COUNT(*) FROM missions ... → 25 (mission count)
-- After:  SELECT COUNT(DISTINCT id) FROM auth.users ... → 3 (real signups)
--
-- Applied to production via Supabase migration on 2026-04-25 with name
-- pass_21_bug_2_funnel_signups_count_distinct_users.
--
-- This file is the source of truth for the RPC body. If you change the RPC,
-- update this file and bump the filename suffix.

CREATE OR REPLACE FUNCTION public.admin_funnel(range_start timestamp with time zone, range_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_admin_user(auth.uid()) THEN RAISE EXCEPTION 'Admin access required'; END IF;

  RETURN jsonb_build_object(
    'landing_views', (
      SELECT COUNT(*) FROM funnel_events
      WHERE event_type IN ('landing_view')
        AND created_at >= range_start AND created_at < range_end
    ),
    'signups', (
      -- Pass 21 Bug 2: distinct authenticated users created in range,
      -- not mission rows.
      SELECT COUNT(DISTINCT id) FROM auth.users
      WHERE created_at >= range_start AND created_at < range_end
    ),
    'setup_started', (
      SELECT COUNT(*) FROM funnel_events
      WHERE event_type IN ('mission_setup_started','setup_started','mission_setup_completed')
        AND created_at >= range_start AND created_at < range_end
    ),
    'payment_reached', (
      SELECT COUNT(*) FROM funnel_events
      WHERE event_type IN ('checkout_opened','payment_reached')
        AND created_at >= range_start AND created_at < range_end
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
