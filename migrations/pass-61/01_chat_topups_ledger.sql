-- ─────────────────────────────────────────────────────────────────────────
-- pass-61: a chat top-up is money, so it needs a row.
--
-- A chat top-up buys +50 chat messages for $5. The webhook credits the
-- messages to the chat session and records the PaymentIntent id in that
-- session's metadata, which makes the CREDIT idempotent. It records the MONEY
-- nowhere. Revenue, invoices and the admin dashboard are all computed from
-- `missions`, and a top-up has no mission, so a paid top-up would be invisible
-- to every business figure the platform reports.
--
-- Audited 2026-09-21 before writing this: zero top-ups have ever been bought
-- (Stripe search by PaymentIntent metadata, plus a direct scan of 53 Checkout
-- Sessions and 35 PaymentIntents; the same search finds mission payments, so
-- the method works). There is nothing to backfill. This table exists so the
-- first one that is bought is recorded.
--
-- The unique PaymentIntent id is the idempotency key, exactly as
-- stripe_refund_ids is for refunds: the webhook inserts on conflict do
-- nothing, so a redelivered event cannot double-count the money.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.chat_topups (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_session_id            uuid REFERENCES public.chat_sessions(id) ON DELETE SET NULL,

  -- One row per Stripe payment. This is what makes recording idempotent.
  stripe_payment_intent_id   text NOT NULL UNIQUE,
  stripe_checkout_session_id text,

  amount_cents               integer NOT NULL CHECK (amount_cents >= 0),
  currency                   text    NOT NULL DEFAULT 'usd',
  messages_granted           integer NOT NULL DEFAULT 50 CHECK (messages_granted >= 0),

  -- Refunds are recorded the same way missions record them (pass-58/59), so
  -- net revenue has one meaning across the product.
  refunded_amount_cents      integer NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  stripe_refund_ids          text[]  NOT NULL DEFAULT '{}',
  refunds_synced_at          timestamptz,

  paid_at                    timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_topups_user_idx    ON public.chat_topups (user_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS chat_topups_paid_at_idx ON public.chat_topups (paid_at);

-- A refund can never exceed the charge.
ALTER TABLE public.chat_topups DROP CONSTRAINT IF EXISTS chat_topups_refund_within_charge;
ALTER TABLE public.chat_topups
  ADD CONSTRAINT chat_topups_refund_within_charge
  CHECK (refunded_amount_cents <= amount_cents);

-- ── Row level security ───────────────────────────────────────────────────
-- A customer may read their own top-ups (their invoices list them). Nobody
-- writes from the browser: every row is written by the webhook with the
-- service role, which bypasses RLS.
ALTER TABLE public.chat_topups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_topups_select_own ON public.chat_topups;
CREATE POLICY chat_topups_select_own ON public.chat_topups
  FOR SELECT USING (auth.uid() = user_id);

-- ── Net revenue, the same rule as missions ───────────────────────────────
CREATE OR REPLACE FUNCTION public.chat_topup_net_revenue_cents(t public.chat_topups)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(COALESCE(t.amount_cents, 0) - COALESCE(t.refunded_amount_cents, 0), 0)
$$;

-- Daily revenue now counts both sources. mission_count keeps counting
-- missions only: it is a count of studies, not of payments, and the admin
-- chart labels it that way.
CREATE OR REPLACE FUNCTION public.daily_revenue_buckets(range_start timestamptz, range_end timestamptz)
RETURNS TABLE(bucket_date date, revenue_usd numeric, mission_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH days AS (
    SELECT generate_series(range_start::date, range_end::date, '1 day'::interval)::date AS d
  ),
  mission_rev AS (
    SELECT m.paid_at::date AS d,
           SUM(public.mission_net_revenue_cents(m)) AS cents,
           COUNT(m.id)::bigint AS missions
    FROM missions m
    WHERE m.paid_at IS NOT NULL
    GROUP BY 1
  ),
  topup_rev AS (
    SELECT t.paid_at::date AS d,
           SUM(public.chat_topup_net_revenue_cents(t)) AS cents
    FROM public.chat_topups t
    GROUP BY 1
  )
  SELECT
    d.d,
    COALESCE(ROUND((COALESCE(mr.cents, 0) + COALESCE(tr.cents, 0)) / 100.0, 2), 0::numeric),
    COALESCE(mr.missions, 0)::bigint
  FROM days d
  LEFT JOIN mission_rev mr ON mr.d = d.d
  LEFT JOIN topup_rev  tr ON tr.d = d.d
  ORDER BY d.d;
END;
$function$;
