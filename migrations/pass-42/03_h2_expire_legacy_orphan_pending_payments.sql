-- Pass 42 H2 — expire legacy orphan pending_payment missions.
--
-- The cron job at src/jobs/missionRecovery.js JOB 2 warns every
-- tick about pending_payment missions older than 6h. Some are
-- legacy (pre-payment_intent tracking) and will never be recoverable.
-- Mark them expired so the cron stops alerting on them.

UPDATE public.missions
   SET status = 'expired',
       failure_reason = COALESCE(
         failure_reason,
         'legacy pre-payment-intent orphan (Pass 42 H2 cleanup)'
       )
 WHERE status = 'pending_payment'
   AND created_at < NOW() - INTERVAL '14 days';

-- Audit query (run after to verify):
--   SELECT count(*) FROM public.missions WHERE status = 'pending_payment' AND created_at < NOW() - INTERVAL '14 days';
--   -- Expected: 0
