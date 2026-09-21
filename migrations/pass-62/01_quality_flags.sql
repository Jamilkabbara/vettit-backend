-- pass-62: a study produced before the quality fixes of 20 September says so.
--
-- Four defects were live at various points before that date: respondents
-- outside the targeted markets, panels that repeated the same person,
-- multi-selects nobody could decline, and answers filed under questions that
-- never offered them. Each flag is decided from the study's OWN stored data
-- (scripts/flag-pre-fix-studies.js), so it names what is actually wrong with
-- that study rather than assuming everything before a date is bad.
--
-- Nothing is deleted and nothing is rewritten: the studies stay exactly as
-- they were delivered, and this column is the only thing added.
--
-- Applied 2026-09-21. 29 of 40 completed studies carry at least one flag:
-- wrong_country 9, duplicate_people 15, undeclinable_q 20, misfiled_answers 11.

ALTER TABLE public.missions ADD COLUMN IF NOT EXISTS quality_flags text[];
ALTER TABLE public.missions ADD COLUMN IF NOT EXISTS quality_flagged_at timestamptz;

COMMENT ON COLUMN public.missions.quality_flags IS
  'Defects found in this delivered study: wrong_country, duplicate_people, undeclinable_q, misfiled_answers. Set by scripts/flag-pre-fix-studies.js. A flagged study is excluded from public surfaces, case studies and benchmarks.';

ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_quality_flags_known;
ALTER TABLE public.missions ADD CONSTRAINT missions_quality_flags_known CHECK (
  quality_flags IS NULL
  OR quality_flags <@ ARRAY['wrong_country','duplicate_people','undeclinable_q','misfiled_answers']::text[]
);

CREATE INDEX IF NOT EXISTS missions_quality_flags_idx ON public.missions USING gin (quality_flags);
