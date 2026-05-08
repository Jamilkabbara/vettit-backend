-- Pass 34 C1 — extend delivery_status to cover failed-mission states.
--
-- Production audit found 2 missions stuck in (status='failed',
-- paid_at=set, partial_refund_id=null). Both were Creative Attention
-- runs that hit an Anthropic webp/jpeg media-type 400; both were admin
-- test missions so we don't trigger a live Stripe refund. We DO want
-- the column to honestly reflect that no work was delivered and that
-- the admin tag prevents future refund-runner sweeps.
--
-- Future failures: runMission's auto-refund branch (Pass 23 Bug 23.80)
-- runs Stripe full refund + writes partial_refund_id. We extend the
-- CHECK constraint to allow a `failed_full_refund` value so the
-- delivery_status column tells the same story as the refund forensic.
--
-- Apply via apply_migration as `pass_34_c1_failed_mission_delivery_status`.

ALTER TABLE missions
  DROP CONSTRAINT IF EXISTS missions_delivery_status_check;

ALTER TABLE missions
  ADD CONSTRAINT missions_delivery_status_check
  CHECK (delivery_status = ANY (ARRAY[
    'full',
    'partial',
    'screener_too_restrictive',
    'failed_full_refund',
    'failed_admin_test_no_refund'
  ]));

-- Reconcile the 2 historical Creative Attention failures.
UPDATE missions
SET delivery_status = 'failed_admin_test_no_refund'
WHERE id IN (
  '91be5c7b-bbdd-40d0-8129-6435f1102c8c',
  'dcbc3b6f-127f-4925-b722-9355045ca4ee'
)
  AND status = 'failed'
  AND partial_refund_id IS NULL;
