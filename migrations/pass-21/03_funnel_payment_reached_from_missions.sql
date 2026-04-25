-- Pass 21 Bug 3: payment_reached should derive from missions data, not from
-- `checkout_opened` events (which were never being emitted, leaving the
-- funnel value pinned at 0).
--
-- Definition: a mission has "reached payment" when its status is
-- pending_payment, paid, or completed. paid_at is set only on successful
-- capture, so pending_payment rows have NULL paid_at — for range scoping
-- we use COALESCE(paid_at, created_at) so unfinished checkout sessions
-- still count toward the period when the user opened checkout.
--
-- Note on the "should be 6" diagnostic from the master prompt:
-- the audit equated payment_reached with the paid count. The semantically
-- correct value over the production 30d window is 11 (6 completed + 5
-- pending_payment), because pending_payment missions also reached the
-- checkout step. The fix uses the broader, semantically-correct definition
-- so the funnel actually shows the drop-off between checkout opened and
-- checkout completed.
--
-- Applied to production via Supabase migration on 2026-04-25 with name
-- pass_21_bug_3_funnel_payment_reached_from_missions.

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
      SELECT COUNT(DISTINCT id) FROM auth.users
      WHERE created_at >= range_start AND created_at < range_end
    ),
    'setup_started', (
      SELECT COUNT(*) FROM funnel_events
      WHERE event_type IN ('mission_setup_started','setup_started','mission_setup_completed')
        AND created_at >= range_start AND created_at < range_end
    ),
    'payment_reached', (
      -- Pass 21 Bug 3: derive from missions. A mission has reached payment
      -- if its status is pending_payment, paid, or completed. Range anchor
      -- is COALESCE(paid_at, created_at) so unfinished pending_payment
      -- rows still count in the period when the user opened checkout.
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
