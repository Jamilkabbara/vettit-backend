-- Pass 29 A1 — Stripe webhook fix: paid_amount_estimated column +
-- backfill of legacy paid missions whose webhook predated Bug 23.25.
--
-- Applied via apply_migration as `pass_29_a1_paid_amount_backfill`.
-- Verified post-apply: 0 missions with paid_at NOT NULL AND
-- paid_amount_cents NULL (was 8). 8 rows now flagged
-- paid_amount_estimated = TRUE; 9 rows are Stripe-confirmed.
--
-- The webhook handler in src/routes/webhooks.js already writes
-- paid_amount_cents on every payment_intent.succeeded event since
-- Pass 23 Bug 23.25. New paid missions get the canonical Stripe
-- value; this migration only addresses the historical gap.

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS paid_amount_estimated BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN missions.paid_amount_estimated IS
  'TRUE for rows backfilled from total_price_usd (Pass 29 A1). FALSE when paid_amount_cents was captured directly from Stripe payment_intent.succeeded webhook (the canonical path).';

UPDATE missions
   SET paid_amount_cents     = ROUND(total_price_usd * 100)::INTEGER,
       paid_amount_estimated = TRUE
 WHERE paid_at IS NOT NULL
   AND paid_amount_cents IS NULL
   AND total_price_usd  IS NOT NULL;
