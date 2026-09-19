-- Pass 60: a checkout session stops being payable the moment the mission it
-- priced changes.
--
-- WHY
-- Customers edit their own mission straight from the browser (RLS allows it
-- while draft or pending_payment). A Stripe Checkout session is created at the
-- price of the mission AS IT WAS, and stays payable for an hour. On
-- 2026-09-18 a customer's session was created for $9 at 5 respondents and the
-- mission then read 1,250 respondents. Paying it would have captured $9; the
-- run guard would then have refused the run, leaving a customer who paid and
-- got nothing.
--
-- WHAT
-- When a price-relevant column changes on a pending_payment mission that has
-- an open session, this trigger:
--   - moves the session id into superseded_checkout_session_ids,
--   - clears checkout_session_id,
--   - puts the mission back to draft, so the next Pay creates a fresh session
--     at the new price.
-- The backend then expires the superseded session in Stripe (on the next
-- checkout, and from the recovery cron). A Checkout session has no
-- PaymentIntent until the customer pays, so a payment cannot be matched to a
-- session up front; instead the payment webhook checks, before marking the
-- mission paid, that the amount covers the mission AS IT NOW IS. A payment
-- that does not is refunded in full and its id recorded in
-- rejected_payment_intent_ids, so it never counts as revenue.
--
-- Price-relevant = what calculateMissionPrice reads: respondent_count,
-- questions, targeting, goal_type, media_type, screener_criteria. Nothing
-- server-side writes these while a session is open.

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS superseded_checkout_session_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rejected_payment_intent_ids     text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.invalidate_open_checkout_on_price_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status = 'pending_payment'
     AND OLD.checkout_session_id IS NOT NULL
     AND (NEW.respondent_count, NEW.questions, NEW.targeting, NEW.goal_type, NEW.media_type, NEW.screener_criteria)
         IS DISTINCT FROM
         (OLD.respondent_count, OLD.questions, OLD.targeting, OLD.goal_type, OLD.media_type, OLD.screener_criteria)
  THEN
    NEW.superseded_checkout_session_ids := array_append(OLD.superseded_checkout_session_ids, OLD.checkout_session_id);
    NEW.checkout_session_id := NULL;
    NEW.status := 'draft';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS missions_invalidate_open_checkout ON public.missions;
CREATE TRIGGER missions_invalidate_open_checkout
  BEFORE UPDATE OF respondent_count, questions, targeting, goal_type, media_type, screener_criteria
  ON public.missions
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_open_checkout_on_price_change();
