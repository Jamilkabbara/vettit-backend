-- ⚠️ SUPERSEDED BY 02. DO NOT RUN THIS FILE.
--
-- This migration is a NO-OP. It was applied to production and reported
-- success while changing nothing: `authenticated` holds UPDATE at the TABLE
-- level, and PostgreSQL does not allow a column-scoped REVOKE to carve a
-- column out of a table-wide grant. It does not error, it simply has no
-- effect. Kept for the record; 02 is the working form.
--
-- Pass 50 — the money and lifecycle columns on `missions` must not be
-- user-writable.
--
-- WHY
-- The RLS policy on public.missions is ownership-only:
--
--   missions_update  USING (auth.uid() = user_id)  WITH CHECK (auth.uid() = user_id)
--
-- There is no column restriction, so a signed-in user can set ANY column on
-- their own mission row through the anon key - including `status`, `paid_at`,
-- `total_price_usd`, `paid_amount_cents` and `latest_payment_intent_id`.
--
-- That is not theoretical. Combined with the mission-recovery job (job 2),
-- which retrieved a PaymentIntent and flipped a row to paid on
-- `pi.status === 'succeeded'` ALONE, it produced a free-compute chain:
--
--   1. pay for one cheap mission, obtain a succeeded PI id
--   2. create a new mission at the top of the self-serve range
--   3. write status='pending_payment' and latest_payment_intent_id=<that PI>
--      straight to the row under RLS
--   4. job 2 retrieves the PI, sees 'succeeded', marks the mission paid and
--      runs it
--
-- and the same PI is reusable indefinitely, because nothing marks one as
-- consumed. The companion commit binds the PI to the mission in job 2. THIS
-- migration removes the write that makes the chain possible at all, which
-- closes the whole class rather than the one instance.
--
-- WHAT THIS DOES NOT BREAK
-- Column-level privileges are independent per command: revoking UPDATE on a
-- column leaves INSERT on that column intact, so the client-side mission
-- INSERT (MissionSetupPage / CreativeAttentionPage, which set `status`
-- 'draft') is unaffected.
--
-- Audited client UPDATEs against `missions` (frontend, origin/main) write only
-- `targeting`, `questions`, `respondent_count` and `price_estimated`:
--   DashboardPage.tsx:431, 451, 511, 546, 590
-- None of them touches a column below. The backend writes through the
-- service-key client, which bypasses RLS and column privileges entirely, so
-- every server-side path is unaffected.
--
-- ROLLBACK is at the bottom of this file.

BEGIN;

-- The lifecycle + money columns the SERVER owns. `authenticated` keeps UPDATE
-- on everything else on the table.
REVOKE UPDATE (
  status,
  paid_at,
  paid_amount_cents,
  paid_amount_estimated,
  total_price_usd,
  base_cost_usd,
  targeting_surcharge_usd,
  extra_questions_cost_usd,
  checkout_session_id,
  latest_payment_intent_id,
  payment_method,
  promo_code,
  target_qualified_count,
  ai_spend_ceiling_usd,
  delivered_respondent_count,
  qualified_respondent_count,
  delivery_status,
  started_at,
  completed_at,
  heartbeat_at
) ON public.missions FROM authenticated;

COMMIT;

-- ── Verification (run AFTER, expect zero rows) ──────────────────────────────
-- Any row returned is a column `authenticated` can still UPDATE that this
-- migration intended to lock.
--
--   SELECT column_name
--   FROM information_schema.column_privileges
--   WHERE table_schema = 'public'
--     AND table_name   = 'missions'
--     AND grantee      = 'authenticated'
--     AND privilege_type = 'UPDATE'
--     AND column_name IN (
--       'status','paid_at','paid_amount_cents','paid_amount_estimated',
--       'total_price_usd','base_cost_usd','targeting_surcharge_usd',
--       'extra_questions_cost_usd','checkout_session_id',
--       'latest_payment_intent_id','payment_method','promo_code',
--       'target_qualified_count','ai_spend_ceiling_usd',
--       'delivered_respondent_count','qualified_respondent_count',
--       'delivery_status','started_at','completed_at','heartbeat_at')
--   ORDER BY column_name;
--
-- And confirm the columns the client DOES write are still writable
-- (expect exactly these four):
--
--   SELECT column_name
--   FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='missions'
--     AND grantee='authenticated' AND privilege_type='UPDATE'
--     AND column_name IN ('targeting','questions','respondent_count','price_estimated')
--   ORDER BY column_name;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- GRANT UPDATE (
--   status, paid_at, paid_amount_cents, paid_amount_estimated, total_price_usd,
--   base_cost_usd, targeting_surcharge_usd, extra_questions_cost_usd,
--   checkout_session_id, latest_payment_intent_id, payment_method, promo_code,
--   target_qualified_count, ai_spend_ceiling_usd, delivered_respondent_count,
--   qualified_respondent_count, delivery_status, started_at, completed_at,
--   heartbeat_at
-- ) ON public.missions TO authenticated;
-- COMMIT;
