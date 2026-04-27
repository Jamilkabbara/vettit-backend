-- Pass 22 Bugs 22.9 + 22.23 — payment_errors telemetry + create-intent idempotency.
--
-- Forensic (from Stripe MCP + missions table cross-reference):
--   * 6+ recent missions stuck in pending_payment with matching Stripe PIs
--     stuck in requires_payment_method.
--   * Bali mission 2926123c has TWO $27.50 PIs (one succeeded earlier, one
--     stuck) on the SAME mission row — proves /api/payments/create-intent
--     creates a fresh PI on every call instead of resuming an open one.
--   * No payment_errors rows currently exist (table never written to).
--
-- This migration:
--   1) Adds telemetry columns to payment_errors so error rows carry full
--      context (PI id, stage, user agent, viewport width).
--   2) Adds latest_payment_intent_id to missions so the create-intent route
--      can look up + reuse an existing in-flight PI before creating a new
--      one. Without this column the route has to query Stripe by metadata
--      every time, which is rate-limited and eventually-consistent.
--
-- Verification:
--   * information_schema.columns shows new columns on both tables.
--   * No data backfill — columns are nullable and populated going forward.

-- ─── 1. Extend payment_errors telemetry columns ──────────────────────────
ALTER TABLE public.payment_errors
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stage_at_failure text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS viewport_width integer;

COMMENT ON COLUMN public.payment_errors.stripe_payment_intent_id IS
  'Stripe PaymentIntent id (pi_*) when known. Lets admin viewer cross-reference with Stripe Dashboard. (Pass 22 Bug 22.9)';
COMMENT ON COLUMN public.payment_errors.stage_at_failure IS
  'Where in the flow the error fired: create_intent | confirm_card | wallet_payment_method | webhook_payment_failed | client_confirm_card | client_wallet_payment_method. (Pass 22 Bug 22.9)';
COMMENT ON COLUMN public.payment_errors.user_agent IS
  'Raw User-Agent string at time of error. browser/os are derived parsings; UA preserves the source. (Pass 22 Bug 22.9)';
COMMENT ON COLUMN public.payment_errors.viewport_width IS
  'window.innerWidth at error time. Helps classify mobile-vs-desktop and identify viewport-specific failure modes. (Pass 22 Bug 22.9)';

-- Index for admin-viewer chronological reads.
-- Pre-existing payment_errors_created_idx may exist (Bug 22.12 advisor flagged
-- as unused — that was before any rows landed). Keep it; the viewer needs it.
CREATE INDEX IF NOT EXISTS idx_payment_errors_stage_created
  ON public.payment_errors (stage_at_failure, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_errors_mission_id
  ON public.payment_errors (mission_id)
  WHERE mission_id IS NOT NULL;

-- ─── 2. Track latest in-flight Stripe PI per mission ─────────────────────
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS latest_payment_intent_id text;

COMMENT ON COLUMN public.missions.latest_payment_intent_id IS
  'Most recent Stripe PaymentIntent id for this mission. Set on create-intent. Used to resume an in-flight PI (requires_payment_method / requires_action / requires_confirmation / processing) instead of sprawling new PIs on every retry. (Pass 22 Bug 22.23)';
