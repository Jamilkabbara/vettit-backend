-- Pass 46 Phase 3 — deterministic methodology analysis.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS analysis jsonb;
COMMENT ON COLUMN public.missions.analysis IS
  'Pass 46 Phase 3 — deterministic methodology analysis computed server-side from mission_responses (src/services/analysis/). Top-level keys: methodology, n, analysis_version, computed_at + per-methodology blocks (brand_lift funnel+significance, pricing VW/GG, roadmap maxdiff+kano, satisfaction nps/csat/ces, naming/compare/competitor/churn/marketing/validate/research). Consumed by the Phase 4 centerpiece renderers and injected into synthesis with a no-recompute rule. The LLM never computes these numbers.';
