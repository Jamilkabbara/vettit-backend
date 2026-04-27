-- Pass 22 Batch 4 — AI structure expansion (Bugs 22.14, 22.15, 22.24).
--
-- Bug 22.14 — persona_response_reasoning table for per-persona "why" traces.
-- Bug 22.15 — segment_breakdowns persisted on missions.insights jsonb (no schema change here).
-- Bug 22.24 — missions.screener_criteria jsonb for user-editable screener calibration.

-- ─── 1. persona_response_reasoning (Bug 22.14) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.persona_response_reasoning (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      text NOT NULL,
  mission_id      uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  question_id     text NOT NULL,
  response_value  text,
  reasoning_text  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prr_mission       ON public.persona_response_reasoning (mission_id);
CREATE INDEX IF NOT EXISTS idx_prr_persona       ON public.persona_response_reasoning (persona_id);
CREATE INDEX IF NOT EXISTS idx_prr_mission_q_resp
  ON public.persona_response_reasoning (mission_id, question_id, response_value);

ALTER TABLE public.persona_response_reasoning ENABLE ROW LEVEL SECURITY;

CREATE POLICY prr_owner_or_admin_select
  ON public.persona_response_reasoning
  FOR SELECT TO authenticated
  USING (
    mission_id IN (SELECT id FROM public.missions WHERE user_id = (SELECT auth.uid()))
    OR public.is_admin_user((SELECT auth.uid()))
  );

COMMENT ON TABLE public.persona_response_reasoning IS
  'Pass 22 Bug 22.14 — per-persona "why" trace. Generated inline in simulate.js prompt and persisted only for missions <=50 personas. RLS: owner or admin SELECT; service_role INSERT.';

-- ─── 2. missions.screener_criteria (Bug 22.24) ───────────────────────────
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS screener_criteria jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.missions.screener_criteria IS
  'Pass 22 Bug 22.24 — user-editable screener acceptance criteria.';
