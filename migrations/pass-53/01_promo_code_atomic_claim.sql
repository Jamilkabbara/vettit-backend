-- Pass 53 - make promo_codes.max_uses enforceable, in the DATABASE.
--
-- NOT APPLIED. This file has not been run against any database. The
-- application works without it (see "WHAT WORKS BEFORE THIS IS APPLIED"
-- below); applying it upgrades one path and turns on another.
--
-- WHAT WAS WRONG
-- promo_codes has max_uses and uses_count, and nothing enforced the
-- relationship between them. There was exactly one writer of uses_count, in
-- src/routes/payments.js on the $0 free-launch path:
--
--   supabase.from('promo_codes')
--     .update({ uses_count: (promo.uses_count || 0) + 1 })
--     .eq('code', promo.code)
--     .then(() => {}).catch(() => {});
--
-- Three separate defects in four lines. The count is read in the application
-- and written back later, so two launches in the same second both read 24 and
-- both write 25 and both run - the 26th use of a 25-use code is free. The call
-- is not awaited and its errors are discarded, so a write that never landed
-- looked exactly like one that did. And no other path wrote the column at all:
-- a percentage or flat-amount code redeemed through Stripe never counted
-- against its own limit, so any such code with a limit behaved as unlimited.
--
-- VETTPROOF demonstrated the race in production.
--
-- WHAT THIS FILE ADDS
--   1. public.promo_redemptions - one row per (code, mission), the ledger that
--      makes redemption idempotent. A retried checkout, or the Stripe webhook
--      arriving while the success page is still polling, redeems ONCE.
--   2. public.claim_promo_code(code, mission_id, source) - reserves the ledger
--      row, then increments uses_count with a single conditional UPDATE that
--      only matches while there is room. Returns whether the claim succeeded,
--      and why not when it did not.
--   3. public.release_promo_code(code, mission_id, source) - hands a use back
--      when the thing it was claimed for then failed, so a customer is never
--      charged a use for a launch that did not happen.
--
-- WHY A FUNCTION AND NOT APPLICATION CODE
-- The claim has to be one statement the database arbitrates. Of two requests
-- racing the last use of a code, Postgres evaluates
--     WHERE ... AND (max_uses IS NULL OR uses_count < max_uses)
-- under a row lock, so exactly one UPDATE matches a row and the other matches
-- none. "No row returned" is the refusal. Nothing the application can do with
-- a read and an addition gets that property.
--
-- WHY NOT A CHECK CONSTRAINT INSTEAD
-- `CHECK (max_uses IS NULL OR uses_count <= max_uses)` was considered and
-- deliberately rejected. Two customers can both have a Stripe Checkout open on
-- the last use of a code and both pay. At that point the money is taken; the
-- only honest response is to honour both missions, log the over-redemption and
-- let an operator decide. A CHECK would instead raise inside payment
-- confirmation, on a customer who has already paid. The conditional UPDATE
-- refuses at the till, which is the right place.
--
-- max_uses NULL STAYS UNLIMITED. So does max_uses = 0, which is how the
-- application has always read it (`promo.max_uses && ...` is false for both).
-- Neither is changed here.
--
-- WHAT WORKS BEFORE THIS IS APPLIED
-- The application does not require these objects. src/services/promo/promoCodes.js
-- calls claim_promo_code first and, when it is not deployed, issues the same
-- conditional UPDATE over PostgREST - equally atomic against max_uses, but
-- with no ledger, so it cannot recognise a retry on its own:
--   - /payments/free-launch uses that fallback. Safe, because the route
--     returns "already_running" for a mission that is already paid, so a retry
--     never reaches the claim.
--   - The paid confirmation paths (Stripe webhook, success-page poll, the
--     webhook-miss cron) REQUIRE the ledger and record nothing without it,
--     because they can confirm the same mission at the same moment and would
--     otherwise double-count. Until this file is applied, paid redemptions
--     stay uncounted exactly as they are today, and the log says so on every
--     confirmation. Applying this file is what starts counting them.
--
-- RLS IS NOT WEAKENED. promo_redemptions has RLS enabled with no policies, so
-- anon and authenticated cannot read or write it at all. The service role,
-- which is the only writer, bypasses RLS as it does everywhere else. Both
-- functions are SECURITY INVOKER (the default) precisely so they cannot become
-- a way around that: called by a client role they would be refused, just as a
-- direct UPDATE on promo_codes is refused today.

BEGIN;

-- 1. The ledger. One row per code per mission; the unique index is what makes
--    a second redemption for the same mission impossible rather than merely
--    unlikely.
--
--    mission_id is TEXT, not UUID, and carries no foreign key. Deliberate: the
--    ledger is an accounting record of what was spent, and it must not become
--    a reason a mission cannot be deleted, nor silently return a use if one is.
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  mission_id  TEXT NOT NULL,
  source      TEXT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_code_mission_uniq
  ON public.promo_redemptions (code, mission_id);

CREATE INDEX IF NOT EXISTS promo_redemptions_code_idx
  ON public.promo_redemptions (code);

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;
-- No policies, on purpose: RLS enabled with zero policies denies every client
-- role. The backend's service role bypasses RLS and is the only writer.
REVOKE ALL ON public.promo_redemptions FROM anon;
REVOKE ALL ON public.promo_redemptions FROM authenticated;
REVOKE ALL ON SEQUENCE public.promo_redemptions_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.promo_redemptions_id_seq FROM authenticated;


-- 2. The claim. Returns jsonb:
--      { "claimed": bool, "reason": text, "uses_count": int, "max_uses": int }
--    reason is one of:
--      claimed           a use was spent
--      already_redeemed  this mission already holds a redemption for this code
--                        (claimed = true, nothing spent - a retry)
--      not_found         no such code
--      inactive          active = false
--      expired           past expires_at
--      exhausted         uses_count has reached max_uses
CREATE OR REPLACE FUNCTION public.claim_promo_code(
  p_code       TEXT,
  p_mission_id TEXT,
  p_source     TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_code      TEXT := upper(btrim(p_code));
  v_ledger_id BIGINT;
  v_row       public.promo_codes%ROWTYPE;
BEGIN
  IF v_code IS NULL OR v_code = '' OR p_mission_id IS NULL OR btrim(p_mission_id) = '' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  -- Reserve the mission's slot FIRST. The unique index is the arbiter: two
  -- concurrent calls for the same mission cannot both insert, so they cannot
  -- both go on to spend a use. A conflict means this mission already redeemed
  -- this code, which is a retry, not a second redemption.
  INSERT INTO public.promo_redemptions (code, mission_id, source)
  VALUES (v_code, btrim(p_mission_id), p_source)
  ON CONFLICT (code, mission_id) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    SELECT * INTO v_row FROM public.promo_codes WHERE code = v_code;
    RETURN jsonb_build_object(
      'claimed', true, 'reason', 'already_redeemed',
      'uses_count', v_row.uses_count, 'max_uses', v_row.max_uses
    );
  END IF;

  -- The whole enforcement, in one statement. Increments only while there is
  -- room; of two callers racing the last use, one UPDATE matches a row and the
  -- other matches none.
  UPDATE public.promo_codes
     SET uses_count = COALESCE(uses_count, 0) + 1
   WHERE code = v_code
     AND COALESCE(active, true)
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_uses IS NULL OR max_uses <= 0 OR COALESCE(uses_count, 0) < max_uses)
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'claimed', true, 'reason', 'claimed',
      'uses_count', v_row.uses_count, 'max_uses', v_row.max_uses
    );
  END IF;

  -- Nothing was spent, so the reservation must not stand.
  DELETE FROM public.promo_redemptions WHERE id = v_ledger_id;

  SELECT * INTO v_row FROM public.promo_codes WHERE code = v_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  ELSIF NOT COALESCE(v_row.active, true) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'inactive');
  ELSIF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'expired');
  ELSE
    RETURN jsonb_build_object(
      'claimed', false, 'reason', 'exhausted',
      'uses_count', v_row.uses_count, 'max_uses', v_row.max_uses
    );
  END IF;
END;
$$;


-- 3. The release. Used when a claim succeeded and the launch it was claimed
--    for then failed. Returns { "released": bool, "reason": text }.
CREATE OR REPLACE FUNCTION public.release_promo_code(
  p_code       TEXT,
  p_mission_id TEXT,
  p_source     TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_code      TEXT := upper(btrim(p_code));
  v_ledger_id BIGINT;
BEGIN
  DELETE FROM public.promo_redemptions
   WHERE code = v_code AND mission_id = btrim(p_mission_id)
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    -- No reservation to undo, so there is nothing this mission is owed back.
    RETURN jsonb_build_object('released', false, 'reason', 'nothing_to_release');
  END IF;

  UPDATE public.promo_codes
     SET uses_count = GREATEST(COALESCE(uses_count, 0) - 1, 0)
   WHERE code = v_code;

  RETURN jsonb_build_object('released', true, 'reason', 'released');
END;
$$;

-- The functions run as the caller (SECURITY INVOKER, the default), so they
-- grant nobody any access they do not already have. EXECUTE goes only to the
-- backend's role.
REVOKE ALL ON FUNCTION public.claim_promo_code(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_promo_code(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_promo_code(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_promo_code(TEXT, TEXT, TEXT) TO service_role;

COMMIT;


-- BACKFILL: none, deliberately.
-- uses_count currently under-counts, because paid redemptions were never
-- recorded. Reconstructing them means writing a redemption history for
-- missions that are already paid and delivered, which is a judgement about
-- historical rows, not a schema change. Counting starts from the next
-- redemption. The history can be read off the missions table at any time
-- without touching a paid row:
--
--   SELECT promo_code, count(*)
--     FROM public.missions
--    WHERE promo_code IS NOT NULL
--      AND status IN ('paid', 'processing', 'completed')
--    GROUP BY promo_code ORDER BY 2 DESC;
--
--
-- -- Verification (read-only, run after) -------------------------------------
--   SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('claim_promo_code', 'release_promo_code');
--   -- expect two rows, prosecdef = false (SECURITY INVOKER) on both.
--
--   SELECT relrowsecurity FROM pg_class
--    WHERE oid = 'public.promo_redemptions'::regclass;   -- expect true
--   SELECT count(*) FROM pg_policies
--    WHERE tablename = 'promo_redemptions';              -- expect 0
--
-- -- Behavioural check, on a code you do not mind spending -------------------
--   -- SELECT public.claim_promo_code('TESTCODE', 'mission-test-1');
--   --   expect {"claimed": true,  "reason": "claimed", ...}
--   -- SELECT public.claim_promo_code('TESTCODE', 'mission-test-1');
--   --   expect {"claimed": true,  "reason": "already_redeemed"}  (nothing spent)
--   -- repeat with fresh mission ids until uses_count = max_uses, then
--   -- SELECT public.claim_promo_code('TESTCODE', 'mission-test-99');
--   --   expect {"claimed": false, "reason": "exhausted", ...}
--   -- SELECT public.release_promo_code('TESTCODE', 'mission-test-1');
--   --   expect {"released": true, "reason": "released"}
--
-- -- Concurrency check (two psql sessions, one code with ONE use left) --------
--   session A: BEGIN; SELECT public.claim_promo_code('TESTCODE', 'm-a');
--   session B: BEGIN; SELECT public.claim_promo_code('TESTCODE', 'm-b');
--              -- B blocks on A's row lock
--   session A: COMMIT;
--   session B: -- unblocks and returns {"claimed": false, "reason": "exhausted"}
--              ROLLBACK;
--   Exactly one claim, which is the whole point of the file.
--
-- -- Rollback ----------------------------------------------------------------
--   DROP FUNCTION IF EXISTS public.claim_promo_code(TEXT, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.release_promo_code(TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.promo_redemptions;
--   -- The application falls back to the conditional UPDATE and keeps
--   -- enforcing max_uses; paid redemptions stop being counted again.
