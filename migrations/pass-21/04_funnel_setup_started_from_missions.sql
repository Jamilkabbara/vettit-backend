-- Pass 21 Bug 4: setup_started should derive from missions table, not from
-- funnel_events. Same doctrine as Bug 3: when frontend event emission is
-- unreliable, derive the value from the authoritative source.
--
-- Forensic finding: in the production 30d window there are 25 mission rows
-- but only 2 funnel_events of type mission_setup_started — the frontend
-- emits the event for roughly 8% of started setups. The original RPC also
-- double-counted by including mission_setup_completed in the same IN
-- clause (2 + 2 = 4), which the audit caught as "off by 2".
--
-- Master prompt audit revision:
-- The master prompt's expected value for setup_started was 2 (the count of
-- mission_setup_started events after dropping mission_setup_completed from
-- the IN clause). The user revised this to 25 after seeing the forensic
-- evidence that the events table is unreliable. Trusting the events count
-- would bake unreliability into the admin funnel permanently and make the
-- funnel non-monotonic (setup_started=2 < payment_reached=11). Deriving
-- from missions restores monotonicity beyond the signups boundary.
--
-- Note on units: signups counts distinct new auth.users; setup_started
-- counts mission rows. A single user can start many missions, so
-- signups < setup_started is not a paradox — they measure different
-- things. signups is a user-acquisition metric; the rest of the funnel
-- is per-mission.
--
-- Followup tracked in docs/PASS_21_REPORT.md → Pass 22 candidates:
-- frontend funnel logging emits ~8% of expected events; investigate
-- dropout root cause (sanitizer? race? wrong code path?).
--
-- Applied to production via Supabase migration on 2026-04-25 with name
-- pass_21_bug_4_funnel_setup_started_from_missions.

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
      -- Pass 21 Bug 4: derive from missions. Every mission row implies a
      -- setup was started, regardless of whether the frontend emitted the
      -- mission_setup_started event (which forensically fires for ~8% of
      -- setups).
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
