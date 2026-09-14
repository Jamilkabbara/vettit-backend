-- Pass 56 - Creative Attention placement, market and audience columns.
--
-- APPLIED to production (hxuhqtczdzmiujrdcrta) on 2026-09-14 as migration
-- pass56_creative_attention_targeting_columns, after the owner approved the
-- statements. Dry run first (inside a transaction forced to roll back): all
-- four constraints rejected bad values and the positive control updated the
-- two drafts. After-state checked: three nullable text columns, four
-- constraints, 0 non-null values, 99 missions, CA target_audience 14 string
-- and 2 object, unchanged.
--
-- WHAT THIS ADDS
--   ca_placement        which placement the creative will run on. Only the
--                       twelve placements VETT holds a published attention
--                       norm for (src/services/creativeAttention/placements.js).
--   ca_market           the market it will run in, a markets_master code.
--                       Qualitative only: it never reaches a number.
--   ca_target_audience  the Creative Attention audience text.
--
-- WHY A NEW AUDIENCE COLUMN
--   public.missions.target_audience is JSONB shared by every mission type. The
--   survey flows store an object in it; the Creative Attention page stored a
--   string. The analysis interpolated the column into its prompts, so a
--   Creative Attention mission holding the object form told the model its
--   audience was "[object Object]" (recorded from unmodified code in
--   test/fixtures/ca_prompts_before.json).
--
--   New Creative Attention missions write ca_target_audience. Existing ones
--   keep their string in target_audience and are still read from there, so no
--   historical row is rewritten. target_audience itself is not touched.
--
-- THE TWO UNRUN DRAFTS
--   e68ee994-8d46-46a9-a9ed-dca440bdba90 and 2a4c806a-8f90-4b1f-b75b-8f6f7a82dc30
--   are goal_type creative_attention,
--   status draft, holding the object form in target_audience, with no media
--   and no creative attachment. They are handled, not cleared: the analysis
--   reads an object as "no audience given" (src/services/creativeAttention/
--   audience.js), and without an attachment neither can run at all. This
--   migration does not modify them.
--
-- WHY THE OTHER TYPES ARE UNAFFECTED
--   Three new nullable columns, NULL on every existing row. No existing column
--   or constraint is changed. missions_ca_fields_only_on_creative_attention
--   makes the database refuse these columns on any other goal type, so a
--   survey, brand lift or any other mission cannot acquire them. No money
--   route reads them (test/pricing_targeting_golden.test.js).
--
-- GRANTS
--   authenticated holds table-level INSERT on public.missions, which covers
--   new columns; CreativeAttentionPage only ever inserts them. No table-level
--   UPDATE is held by authenticated and none is added, so a customer cannot
--   change a placement or market after creating the mission.
--
-- VALIDITY
--   All three columns are NULL on every existing row, so every constraint
--   below holds for all current rows and is added VALID, not NOT VALID. (A
--   NOT VALID CHECK is re-evaluated on any later UPDATE of the row, including
--   updates to unrelated columns, which is not a trap worth leaving.)

BEGIN;

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS ca_target_audience text,
  ADD COLUMN IF NOT EXISTS ca_placement       text,
  ADD COLUMN IF NOT EXISTS ca_market          text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_ca_placement_known') THEN
    ALTER TABLE public.missions
      ADD CONSTRAINT missions_ca_placement_known
      CHECK (ca_placement IS NULL OR ca_placement IN (
        'instagram_feed', 'tiktok_feed', 'youtube_preroll', 'pinterest', 'snapchat', 'meta_reels_stories', 'programmatic_display', 'ooh_digital_billboard', 'ctv_15s', 'ctv_30s', 'tv_30s', 'print_luxury_magazine'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_ca_market_fkey') THEN
    ALTER TABLE public.missions
      ADD CONSTRAINT missions_ca_market_fkey
      FOREIGN KEY (ca_market) REFERENCES public.markets_master (code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_ca_target_audience_length') THEN
    ALTER TABLE public.missions
      ADD CONSTRAINT missions_ca_target_audience_length
      CHECK (ca_target_audience IS NULL OR char_length(ca_target_audience) <= 1000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_ca_fields_only_on_creative_attention') THEN
    ALTER TABLE public.missions
      ADD CONSTRAINT missions_ca_fields_only_on_creative_attention
      CHECK (
        goal_type = 'creative_attention'
        OR (ca_target_audience IS NULL AND ca_placement IS NULL AND ca_market IS NULL)
      );
  END IF;
END
$$;

COMMIT;

-- ── Verification (read-only, run after) ─────────────────────────────────────
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='missions' AND column_name LIKE 'ca\_%';
--   -- three rows, text, YES
--   SELECT conname FROM pg_constraint WHERE conrelid='public.missions'::regclass AND conname LIKE 'missions_ca_%';
--   -- four rows
--   SELECT count(*) FROM public.missions WHERE ca_placement IS NOT NULL OR ca_market IS NOT NULL OR ca_target_audience IS NOT NULL;
--   -- 0 immediately after applying
--
-- Must fail (proves the constraints bite). Each in its own BEGIN ... ROLLBACK,
-- and scoped to DRAFT rows so no paid-row guardrail can make a check pass or
-- fail for a reason other than the constraint under test:
--   UPDATE public.missions SET ca_placement = 'shahid'
--    WHERE goal_type = 'creative_attention' AND status = 'draft';      -- missions_ca_placement_known
--   UPDATE public.missions SET ca_market = 'NOT_A_MARKET'
--    WHERE goal_type = 'creative_attention' AND status = 'draft';      -- missions_ca_market_fkey
--   UPDATE public.missions SET ca_placement = 'tiktok_feed'
--    WHERE goal_type = 'validate' AND status = 'draft';                -- missions_ca_fields_only_on_creative_attention
-- Positive control (must succeed, then ROLLBACK):
--   UPDATE public.missions SET ca_placement = 'tiktok_feed', ca_market = 'SA'
--    WHERE goal_type = 'creative_attention' AND status = 'draft';
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   ALTER TABLE public.missions
--     DROP CONSTRAINT IF EXISTS missions_ca_fields_only_on_creative_attention,
--     DROP CONSTRAINT IF EXISTS missions_ca_target_audience_length,
--     DROP CONSTRAINT IF EXISTS missions_ca_market_fkey,
--     DROP CONSTRAINT IF EXISTS missions_ca_placement_known,
--     DROP COLUMN IF EXISTS ca_market,
--     DROP COLUMN IF EXISTS ca_placement,
--     DROP COLUMN IF EXISTS ca_target_audience;
