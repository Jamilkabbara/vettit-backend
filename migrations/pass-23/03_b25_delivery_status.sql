-- =============================================================================
-- Pass 23 Bug 23.25 — delivery integrity + partial refund tracking.
--
-- Forensic from production: 4 of 8 completed missions had qualified_respondent_count
-- < respondent_count yet finished without flagging or refunding:
--   Bali              paid_for=10  qualified=5
--   Travel superapp   paid_for=10  qualified=1
--   Cat hotel SHJ     paid_for=10  qualified=4
--   Lebanon influencer paid_for=10 qualified=7
--
-- runMission stops at exactly N personas; the screener can drop personas after
-- simulation, leaving the qualified gap unaddressed. Promise-of-purchase
-- violation against the landing page "100% always delivered" claim.
--
-- Pre-existing state: missions.delivery_status text already exists with a
-- CHECK constraint allowing {'full','partial','screener_too_restrictive'} but
-- code never actually wrote it (some legacy update set 'full' on 6 missions
-- and missed the other 2). 2 of the 'full' rows are wrong. This migration
-- renormalises the column and adds the columns we still need:
--   paid_amount_cents              source of truth for partial refunds
--   partial_refund_id              Stripe refund id (idempotency forensic)
--   partial_refund_amount_cents    refund amount in cents
--   delivery_check_at              when runMission decided
--
-- Code changes ship in the same PR (runMission.js over-recruit loop +
-- webhooks.js paid_amount_cents + latest_payment_intent_id stamping +
-- missionSchema.js ALLOWED_COLUMNS additions).
-- =============================================================================

-- ── New columns ─────────────────────────────────────────────────────────────
-- paid_amount_cents: cached from pi.amount_received at PI succeed. We can't
-- refund proportionally against total_price_usd if a Stripe-side promo was
-- redeemed at Checkout (actual charge < total_price_usd). Caching here means
-- runMission's refund branch doesn't need an extra Stripe round-trip.
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS paid_amount_cents integer;
ALTER TABLE missions
  DROP CONSTRAINT IF EXISTS missions_paid_amount_cents_chk;
ALTER TABLE missions
  ADD CONSTRAINT missions_paid_amount_cents_chk
  CHECK (paid_amount_cents IS NULL OR paid_amount_cents >= 0);

COMMENT ON COLUMN missions.paid_amount_cents IS
  'Pass 23 Bug 23.25 — pi.amount_received in cents, stamped by the '
  'payment_intent.succeeded webhook. Source of truth for partial refunds.';

-- partial_refund forensic + idempotency (the runMission refund branch uses a
-- Stripe idempotency_key to avoid double-refunds across retries; the id
-- and amount lands here once Stripe responds).
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS partial_refund_id text;
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS partial_refund_amount_cents integer;
ALTER TABLE missions
  DROP CONSTRAINT IF EXISTS missions_partial_refund_amount_cents_chk;
ALTER TABLE missions
  ADD CONSTRAINT missions_partial_refund_amount_cents_chk
  CHECK (partial_refund_amount_cents IS NULL OR partial_refund_amount_cents >= 0);

COMMENT ON COLUMN missions.partial_refund_id IS
  'Pass 23 Bug 23.25 — Stripe refund id when delivery_status=partial and an '
  'auto-refund landed. NULL if delivery_status=full OR refund failed (the '
  'corresponding admin_alerts row records the failure).';
COMMENT ON COLUMN missions.partial_refund_amount_cents IS
  'Pass 23 Bug 23.25 — refund amount in cents (matches what Stripe credited).';

-- delivery_check_at: when runMission applied the decision. Distinct from
-- completed_at (mission completion); useful for forensics if the two diverge.
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS delivery_check_at timestamptz;
COMMENT ON COLUMN missions.delivery_check_at IS
  'Pass 23 Bug 23.25 — when runMission applied delivery_status. NULL on '
  'backfilled historical rows (decision time unknown).';

-- ── Index: partial-delivery missions for admin dashboard queries ────────────
CREATE INDEX IF NOT EXISTS idx_missions_delivery_status_partial
  ON missions (created_at DESC)
  WHERE delivery_status = 'partial';

-- ── BACKFILL — relabel historical missions only. Do NOT trigger refunds. ────
-- Idempotent: rewrites every completed mission's delivery_status from the
-- ground-truth qualified/respondent comparison. Correct-already rows are
-- no-ops. The 2 incorrectly-labeled 'full' rows (Cat hotel SHJ, Travel
-- superapp) and the 2 NULL rows (Bali, Lebanon) all flip to 'partial'.
-- Refunds are NOT triggered — those were pre-fix; the relabel is purely for
-- accuracy of the /missions list and admin dashboards going forward.
UPDATE missions
SET delivery_status = CASE
  WHEN COALESCE(qualified_respondent_count, 0) >= respondent_count THEN 'full'
  ELSE 'partial'
END
WHERE status = 'completed'
  AND respondent_count IS NOT NULL;

-- Sanity report — audit chat reads these counts to confirm the backfill.
DO $$
DECLARE
  full_count int;
  partial_count int;
  null_completed_count int;
BEGIN
  SELECT COUNT(*) INTO full_count
    FROM missions WHERE delivery_status = 'full';
  SELECT COUNT(*) INTO partial_count
    FROM missions WHERE delivery_status = 'partial';
  SELECT COUNT(*) INTO null_completed_count
    FROM missions WHERE status = 'completed' AND delivery_status IS NULL;
  RAISE NOTICE 'Pass 23 Bug 23.25 backfill: full=% partial=% null_completed=%',
    full_count, partial_count, null_completed_count;
END $$;
