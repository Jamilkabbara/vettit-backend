-- Pass 50 (CORRECTION to 01) - the column-scoped REVOKE in 01 was a NO-OP.
--
-- WHAT HAPPENED
-- 01 ran `REVOKE UPDATE (col, col, ...) ON public.missions FROM authenticated`.
-- It reported success and changed NOTHING: the verification query still
-- returned all 20 columns as user-updatable.
--
-- WHY. `authenticated` holds UPDATE at the TABLE level, not per column:
--
--   pg_class.relacl = {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--                      authenticated=arwdDxtm/postgres,
--                      service_role=arwdDxtm/postgres}
--
-- and 0 of the table's 118 columns carry an ACL of their own. PostgreSQL will
-- not let you carve a column out of a table-wide grant - a column-scoped
-- REVOKE against one is documented as having no effect, and it does not error.
-- That combination is the trap: `success: true` and zero change.
--
-- THE CORRECT FORM is necessarily deny-by-default: drop the table-level grant,
-- then grant back exactly the columns the client legitimately writes.
--
-- SCOPE - READ THIS. This is BROADER than 01 intended. 01 would have denied 20
-- named columns. This denies UPDATE on ALL 118 except the four granted below.
-- That is strictly safer, but it means any client write to a column not listed
-- here now fails.
--
-- Audited against frontend main 602fb1b: `missions` is touched at 16 sites,
-- nine of them SELECT (including PaymentSuccessPage, which only reads
-- goal_type). The writes are:
--   INSERT  MissionSetupPage.tsx:1439, CreativeAttentionPage.tsx:191
--   UPDATE  DashboardPage.tsx:431,451,546  -> targeting
--           DashboardPage.tsx:511          -> questions
--           DashboardPage.tsx:590          -> respondent_count, price_estimated
-- Nothing else client-side updates this table.
--
-- INSERT is untouched. Column privileges are per-command, so revoking UPDATE
-- does not affect the two client INSERTs, which set `status`,
-- `target_qualified_count` and `ai_spend_ceiling_usd` among others.
--
-- The backend writes through the service-key client, which bypasses RLS and
-- column privileges entirely. No server path changes.
--
-- The companion frontend change makes a denial visible: all four write sites
-- now surface the actual Postgres message instead of "try again in a moment",
-- so a path missed by the audit announces itself with the column name.

BEGIN;

-- anon cannot satisfy the RLS policy (auth.uid() = user_id) anyway, so it has
-- no legitimate UPDATE on this table. Remove it rather than leave it relying
-- on RLS alone.
REVOKE UPDATE ON public.missions FROM anon;

REVOKE UPDATE ON public.missions FROM authenticated;
GRANT  UPDATE (targeting, questions, respondent_count, price_estimated)
  ON public.missions TO authenticated;

COMMIT;

-- ── Verification. Run all three; each must return what it says. ─────────────
--
-- V1  the money/lifecycle columns are no longer updatable. EXPECT 0 ROWS.
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='missions'
--     AND grantee='authenticated' AND privilege_type='UPDATE'
--     AND column_name IN ('status','paid_at','paid_amount_cents',
--       'paid_amount_estimated','total_price_usd','base_cost_usd',
--       'targeting_surcharge_usd','extra_questions_cost_usd',
--       'checkout_session_id','latest_payment_intent_id','payment_method',
--       'promo_code','target_qualified_count','ai_spend_ceiling_usd',
--       'delivered_respondent_count','qualified_respondent_count',
--       'delivery_status','started_at','completed_at','heartbeat_at');
--
-- V2  exactly the four client-written columns remain. EXPECT EXACTLY 4 ROWS:
--     price_estimated, questions, respondent_count, targeting
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='missions'
--     AND grantee='authenticated' AND privilege_type='UPDATE'
--   ORDER BY column_name;
--
-- V3  INSERT is untouched. EXPECT 3 ROWS.
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='missions'
--     AND grantee='authenticated' AND privilege_type='INSERT'
--     AND column_name IN ('status','total_price_usd','target_qualified_count');

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- BEGIN;
-- GRANT UPDATE ON public.missions TO authenticated;
-- GRANT UPDATE ON public.missions TO anon;
-- COMMIT;
