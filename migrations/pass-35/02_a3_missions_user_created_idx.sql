-- Pass 35 A3 — composite index for sub-1.5s dashboard load.
--
-- Pre-Pass-33 dashboard cold-load was ~10s. Pass 33 W10 trimmed the
-- payload from 184 kB to <30 kB via column-list select, but the
-- WHERE user_id = ? ORDER BY created_at DESC still triggered a sort
-- because idx_missions_user only covered (user_id) without a sort
-- direction on created_at.
--
-- Composite index makes it an index-only scan with the sort baked in.
-- EXPLAIN ANALYZE confirmed Execution Time: 0.28ms post-deploy
-- (Bitmap Index Scan on idx_missions_user_created).
--
-- Apply via apply_migration as `pass_35_a3_missions_user_created_idx`.

CREATE INDEX IF NOT EXISTS idx_missions_user_created
  ON public.missions(user_id, created_at DESC);
