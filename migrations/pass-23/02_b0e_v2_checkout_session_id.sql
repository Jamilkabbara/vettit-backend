-- Pass 23 Bug 23.0e v2 — full Stripe Checkout migration.
-- Applied live as pass_23_b0e_v2_checkout_session_id; this is the audit-trail snapshot.
--
-- After multiple rounds of Stripe Elements iframe-mount work (Pass 22 ready
-- gating, Pass 23 Bug 23.0a 2-frame rAF defer + 5s timeout + retry, anon
-- telemetry endpoint via 23.0c, idempotent create-intent via 22.9 +
-- Stripe metadata salvage via 23.0d), Safari Mac still reproduces the
-- "Element is not mounted and ready event has not emitted" error AFTER
-- the user has clicked through. The failure is at the Stripe SDK
-- ref/lifecycle handoff — upstream of every wrapped catch.
--
-- Decision: surrender inline Elements UX, migrate to Stripe Checkout
-- (redirect to checkout.stripe.com). Standard pattern for $9-$199 SaaS
-- (Notion, Linear, ClickUp, etc.).
--
-- This migration adds missions.checkout_session_id to track the active
-- Stripe Checkout Session per mission, parallel to latest_payment_intent_id
-- (which Stripe still creates as part of the Checkout flow).

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS checkout_session_id text;

COMMENT ON COLUMN public.missions.checkout_session_id IS
  'Active Stripe Checkout Session id (cs_*) for this mission. Set on POST /api/payments/create-checkout-session. The user is redirected to checkout.stripe.com/c/pay/cs_*. On webhook checkout.session.completed: marked paid + runMission triggered. On checkout.session.expired: cleared so user can retry. (Pass 23 Bug 23.0e v2)';

CREATE INDEX IF NOT EXISTS idx_missions_checkout_session_id
  ON public.missions (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
