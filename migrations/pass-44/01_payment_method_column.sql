-- Pass 44 — missions.payment_method (APPLIED to production 2026-06-12
-- via Supabase MCP during the delegated audit; this file is the repo
-- record). The Pass 42 F1 admin mark-paid endpoint has written this
-- column since it shipped, but the column was never created: every
-- happy-path mark-paid 500'd at the UPDATE. Agent C's idempotency
-- probes only exercised the pre-update guards (409 completed /
-- 400 reason_required), which is why the audit initially passed it.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS payment_method text;

COMMENT ON COLUMN public.missions.payment_method IS
  'Pass 44 — how the mission was paid: admin_override (F1 mark-paid) or NULL for Stripe checkout.';
