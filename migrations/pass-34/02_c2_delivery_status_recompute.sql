-- Pass 34 C2 — recompute delivery_status from ground truth.
--
-- Pre-W4 the column held paid_for; W4 rebackfilled it to total
-- mission_responses ROW count. The 5 missions still flagged 'partial'
-- now have delivered_respondent_count > respondent_count (10 → 14, 26,
-- 30, 37, 38) — i.e. the flag is logically inconsistent with the
-- post-W4 column it's meant to summarize.
--
-- Recompute the flag using a rows-vs-paid comparison so the column
-- and flag tell the same story. CA missions stay outside this loop
-- (they have delivery_unit='creative_asset', no respondent rows).
-- Failed missions go through C1's failed_full_refund / failed_admin_test
-- path; they are excluded here.
--
-- For any row that flips partial → full because we over-delivered,
-- emit an admin alert for visibility (no refund — the customer got
-- more than they paid for, not less).
--
-- Apply via apply_migration as `pass_34_c2_delivery_status_recompute`.

-- 1. Capture the IDs that will flip partial → full so we can alert.
CREATE TEMP TABLE _c2_flip AS
SELECT id, respondent_count, delivered_respondent_count
FROM missions
WHERE delivery_status = 'partial'
  AND status = 'completed'
  AND paid_at IS NOT NULL
  AND goal_type != 'creative_attention'
  AND delivered_respondent_count >= respondent_count;

-- 2. Recompute the flag from ground truth.
UPDATE missions m
SET delivery_status = CASE
  WHEN m.goal_type = 'creative_attention' AND m.status = 'completed' THEN 'full'
  WHEN m.delivered_respondent_count >= m.respondent_count THEN 'full'
  WHEN m.delivered_respondent_count > 0 THEN 'partial'
  ELSE 'partial'  -- 0 rows delivered + status='completed' is rare; flag for admin
END
WHERE m.paid_at IS NOT NULL
  AND m.status = 'completed'
  -- Don't clobber C1's failed_full_refund / failed_admin_test_no_refund.
  AND (m.delivery_status IS NULL OR m.delivery_status NOT LIKE 'failed_%');

-- 3. Emit admin alert for the over-delivered rows.
INSERT INTO admin_alerts (alert_type, mission_id, payload, resolved)
SELECT
  'over_delivered_no_refund',
  f.id,
  jsonb_build_object(
    'paid_for', f.respondent_count,
    'delivered', f.delivered_respondent_count,
    'note', 'Pass 34 C2 backfill: partial→full because rows exceed paid_for'
  ),
  false
FROM _c2_flip f
ON CONFLICT DO NOTHING;

DROP TABLE _c2_flip;
