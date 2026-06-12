-- Pass 45 T1a — aggregated_by_question column. (APPLIED to production
-- 2026-06-12 via Supabase MCP; this file is the repo record.)
--
-- 9 of 12 result renderers select this column via supabase-js; it
-- never existed, and supabase-js fails the ENTIRE row fetch when a
-- selected column is missing — so Validate/Pricing/Roadmap/Naming/
-- AdTesting/CompetitorAnalysis/Compare/CSAT/Churn all rendered
-- "Mission not found" on completed missions.

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS aggregated_by_question jsonb;

COMMENT ON COLUMN public.missions.aggregated_by_question IS
  'Pass 45 — per-question aggregation map keyed by question_id: { <qid>: { distribution: {answer: count}, average: number|null, n: int, verbatims: string[] } }. Consumed by all methodology result renderers (CSAT/Naming/Pricing/etc.). Written by synthesis pipeline at completion.';
