-- Pass 22 Bug 22.10d hotfix — one-time cleanup of duplicate legacy alerts.
--
-- Production state pre-cleanup: 150 rows of
-- orphan_pending_payment_legacy_unsafe_to_auto_reset (6 missions × 25 dupes
-- each), accumulated since the 0204240 alert-only hotfix landed. Job 2's
-- alert-only branch fires every 30min for the same legacy orphans without
-- checking for an existing unresolved alert.
--
-- The matching code change to alertAdmin() in src/jobs/missionRecovery.js
-- centralises the dedup so future ticks skip when an unresolved alert
-- already exists for (alert_type, mission_id). This migration cleans up
-- the existing backlog so admin_alerts stays at 1 row per legacy mission.
--
-- Strategy: keep the EARLIEST row per (alert_type, mission_id) by
-- created_at, drop the rest. Postgres has no native MIN(uuid) so we
-- partition by mission_id and keep rn=1 from ORDER BY created_at ASC.
--
-- Verification: SELECT COUNT(*) FROM admin_alerts WHERE alert_type='...'
-- returns 6 immediately after this migration; subsequent cron ticks do
-- not re-add duplicates because alertAdmin now SELECTs first.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY mission_id ORDER BY created_at ASC) AS rn
  FROM public.admin_alerts
  WHERE alert_type = 'orphan_pending_payment_legacy_unsafe_to_auto_reset'
)
DELETE FROM public.admin_alerts
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
