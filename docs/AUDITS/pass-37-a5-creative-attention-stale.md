# Pass 37 A5 — Creative Attention stale-mission backfill

## Problem

Creative Attention missions can land with `creative_analysis IS NULL`
and `status` stuck on `'paid'` or `'processing'` — the pipeline timed
out or crashed without flipping the row to `'failed'`. May 12 audit
found mission `91be5c7b-...` in this state for 36 hours.

Symptom: `/creative-results/:missionId` polled forever, no failure
UI, no recourse.

## Frontend fix (pass-37-verification-and-closure, vett-platform)

`CreativeAttentionResultsPage` now treats CA missions older than 30
min with NULL analysis as failed even when `status` is not flagged.
Poll loop hard-stops after 5 min. See:
  - `src/pages/CreativeAttentionResultsPage.tsx`
  - `src/pages/__perf__/creative-attention-stale-audit.md`

## Backend backfill SQL

Run once against production Supabase:

```sql
-- Flip stale CA missions to status='failed' so the explicit-failure
-- path on the frontend takes precedence over the staleness heuristic.
-- Conservative: only rows older than 1 hour with NULL analysis AND
-- status not already 'completed'/'failed' are touched.
WITH stale AS (
  SELECT id, status, created_at
    FROM public.missions
   WHERE goal_type        = 'creative_attention'
     AND creative_analysis IS NULL
     AND status NOT IN ('completed', 'failed')
     AND created_at < NOW() - INTERVAL '1 hour'
)
UPDATE public.missions m
   SET status         = 'failed',
       failure_reason = COALESCE(failure_reason,
         'Creative analysis pipeline timed out (Pass 37 A5 backfill)')
  FROM stale s
 WHERE m.id = s.id;
```

Re-run the SELECT half before and after to verify zero rows post-backfill.

## Forward hardening (Pass 37 E1 followup)

`services/ai/creativeAttention.js` (or wherever the CA pipeline
catches) must set `status='failed'` + `failure_reason='<error message>'`
on every catch path. Right now some failure modes drop without
updating the row, which is why this backfill exists. The frontend
staleness heuristic becomes a safety net rather than the primary
signal once that's done.

## Verification

After deploy + backfill:
1. SELECT count = 0 for the stale query above
2. Manually inspect mission `91be5c7b-...` — should show `status='failed'`
3. Visit `/creative-results/91be5c7b-...` — should show the new
   failure UI with "Try a new analysis" CTA
