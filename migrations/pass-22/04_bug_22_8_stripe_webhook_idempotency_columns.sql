-- Pass 22 Bug 22.8 — Stripe webhook idempotency.
--
-- Forensic: stripe_webhook_events table exists (0 rows; never written to)
-- with event_id as PRIMARY KEY (uniqueness already enforced). The
-- processed_at column is NOT NULL today, which prevents the "claim row at
-- receive time, mark processed at completion" pattern that distinguishes
-- "Stripe retry of an event we already finished" (skip) from "Stripe retry
-- of an event we started but crashed mid-handler" (reprocess).
--
-- This migration:
--   1) Adds received_at timestamptz NOT NULL DEFAULT now() — the claim
--      timestamp, set on first INSERT. PRIMARY KEY on event_id makes the
--      INSERT itself the idempotency guard (23505 on retry).
--   2) Makes processed_at nullable — set only after the handler's branch
--      finishes its side-effects. NULL means "received, but processing did
--      not complete" → safe to reprocess on Stripe retry.
--   3) Drops the legacy DEFAULT now() on processed_at so an INSERT that
--      doesn't explicitly set it leaves it NULL (the semantics the
--      idempotency handler relies on).
--   4) Adds a partial index on received_at WHERE processed_at IS NULL
--      so Bug 22.10 (mission status recovery cron) can cheaply find
--      events that were claimed but never finalised.
--
-- Crash semantics:
--   * Crash before INSERT  → Stripe retries with original event_id; INSERT
--                            succeeds; processed normally.
--   * Crash between INSERT and processing complete → Stripe retries; second
--                            INSERT hits 23505; handler checks processed_at
--                            (NULL); reprocesses event safely (downstream
--                            handlers — runMission, mission status updates
--                            — are themselves idempotent).
--   * Crash after processing complete → processed_at is set; Stripe retry
--                            skips at the idempotency check.
--
-- Verification:
--   * pg_attribute shows processed_at is_nullable + received_at default.
--   * No row backfill needed (table is empty).

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN processed_at DROP NOT NULL;

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN processed_at DROP DEFAULT;

COMMENT ON COLUMN public.stripe_webhook_events.received_at IS
  'Set on INSERT when the webhook handler first sees the event. Combined with the event_id PK, this is the idempotency claim. (Pass 22 Bug 22.8)';
COMMENT ON COLUMN public.stripe_webhook_events.processed_at IS
  'Set after the handler branch finishes all side-effects. NULL means processing did not complete (handler crash, downstream error). Stripe retries will reprocess events with NULL processed_at. (Pass 22 Bug 22.8)';

-- Index for the recovery / observability cron query: "events received >5min
-- ago that never finished processing." Bug 22.10 will use this.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_unprocessed
  ON public.stripe_webhook_events (received_at)
  WHERE processed_at IS NULL;
