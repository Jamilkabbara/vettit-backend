-- Applied to production 2026-09-15 as pass57_mission_refund_columns.
-- Stripe refunds were never recorded: 21 of the 22 Stripe charges for
-- missions were refunded in full and every one still read as paid.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS refunded_amount_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_refund_ids     text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS refunds_synced_at     timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_refunded_amount_nonneg') THEN
    ALTER TABLE public.missions ADD CONSTRAINT missions_refunded_amount_nonneg CHECK (refunded_amount_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_refunds_only_after_payment') THEN
    ALTER TABLE public.missions ADD CONSTRAINT missions_refunds_only_after_payment
      CHECK (paid_at IS NOT NULL OR (refunded_amount_cents = 0 AND cardinality(stripe_refund_ids) = 0 AND refunds_synced_at IS NULL));
  END IF;
END
$$;

COMMENT ON COLUMN public.missions.refunded_amount_cents IS
  'Cumulative amount refunded in Stripe for this mission''s payment, set from the Stripe charge (amount_refunded), never incremented. Written by the charge.refunded / charge.refund.updated webhook and scripts/backfill-stripe-refunds.js. Supersedes partial_refund_amount_cents.';
