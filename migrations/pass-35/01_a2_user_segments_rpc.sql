-- Pass 35 A2 — User Segments: replace role-based segmentation with
-- mission-volume buckets. The previous RPC bucketed by profiles.role
-- which is a freeform string mostly NULL → all users showed up under
-- "Unknown" with $0 LTV.
--
-- New buckets:
--   Power:           paid_missions >= 5
--   Active:          paid_missions BETWEEN 1 AND 4
--   Trial:           any missions, 0 paid
--   Signed up only:  zero missions on file
--
-- Apply via apply_migration as `pass_35_a2_user_segments_rpc`.

CREATE OR REPLACE FUNCTION public.admin_user_segments()
 RETURNS TABLE(segment text, user_count bigint, avg_ltv numeric, total_ltv numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH user_stats AS (
    SELECT
      p.id AS uid,
      COUNT(m.id) AS missions,
      COUNT(m.id) FILTER (WHERE m.status IN ('paid','completed')) AS paid_missions,
      COALESCE(SUM(CASE WHEN m.status IN ('paid','completed')
                        THEN m.total_price_usd ELSE 0 END), 0::numeric) AS spent
    FROM profiles p
    LEFT JOIN missions m ON m.user_id = p.id
    GROUP BY p.id
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN paid_missions >= 5 THEN 'Power users'
        WHEN paid_missions BETWEEN 1 AND 4 THEN 'Active users'
        WHEN missions > 0 THEN 'Trial users'
        ELSE 'Signed up only'
      END AS seg,
      uid,
      spent
    FROM user_stats
  )
  SELECT
    b.seg,
    COUNT(*)::bigint,
    ROUND(AVG(b.spent)::numeric, 2),
    ROUND(SUM(b.spent)::numeric, 2)
  FROM bucketed b
  GROUP BY b.seg
  ORDER BY
    CASE b.seg
      WHEN 'Power users'     THEN 1
      WHEN 'Active users'    THEN 2
      WHEN 'Trial users'     THEN 3
      WHEN 'Signed up only'  THEN 4
    END;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_user_segments() FROM PUBLIC, anon, authenticated;
