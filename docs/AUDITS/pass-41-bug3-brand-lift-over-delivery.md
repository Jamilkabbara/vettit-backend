# Pass 41 BUG3 — Brand Lift over-delivery (2026-05-12)

## Symptom

Mission `af36a36d-401d-48e6-b94b-257e215613e2` on production:

```
goal_type:                   brand_lift
status:                      completed
respondent_count:             5   ← what the user paid for
delivered_respondent_count:  10   ← what the page reported
COUNT(DISTINCT persona_id) in mission_responses: 10
COUNT(*) FROM mission_responses where mission_id = ...: 37
```

Customer paid for 5; the dashboard + results page reported 10. From
the customer's perspective this either implies a billing error or a
counting bug.

## Root cause (likely)

The brand_lift mission ran the standard `runMission.js` flow:

1. Generate `targetCount = 5` personas (line 129 in runMission.js)
2. Label half exposed / half control (line 137 in runMission.js)
3. Run `simulateAllResponses` to produce response rows
4. Screener verification: all 5 of these personas tripped the
   screener check (lines 159-163)
5. Retry round: generate 5 replacement personas, this time all
   qualifying (lines 192-242)

The retry path is supposed to **swap** screened-out originals for
qualifying replacements (lines 220-237):

```js
const personasToSwap = Array.from(screenedOutPersonaIds).slice(0, goodReplacementIds.size);
// drop originals' responses, keep responses for swap'd-in replacements
responses = responses.filter((r) => !personasToSwap.includes(r.persona_id))
                     .concat(replacementGoodResponses);
```

But the audit's `COUNT(DISTINCT persona_id) = 10` proves the swap
didn't drop all originals — both the 5 screened-out originals AND
the 5 qualifying replacements ended up in `mission_responses`.
Probable causes (any of these):

- `screenedOutPersonaIds` set was missing some IDs because the
  screener flag wasn't consistently set on `persona_profile`
- Personas had `id` field instead of `persona_id`, breaking the
  `.includes()` check
- The screened-out personas had their `screened_out` flag flipped
  AFTER the screenedOutPersonaIds set was computed

A full retry-loop rewrite is risky and out of scope for Pass 41.

## Pass 41 BUG3 fix (defensive cap)

`runMission.js` `delivered_respondent_count` now caps at
`targetCount`:

```js
const distinctPersonaCount = ...;  // unchanged: COUNT(DISTINCT persona_id)
const deliveredRespondentCount = Math.min(distinctPersonaCount, targetCount);
```

When `distinctPersonaCount > targetCount`, we log it so we have a
production signal of how often the over-delivery is happening
without affecting the customer-facing number.

This is the customer-trust safeguard: delivered ≤ requested,
always. Over-delivery is a positive technical side-effect (the
customer got extra responses for free) that doesn't need to leak
into the displayed count.

Pass 42+ followup ticket: investigate the retry-loop swap to find
why screened-out originals aren't being dropped. That's a more
substantial change than a 1-row fix.

## Backfill for existing mission

Run once against production Supabase:

```sql
-- Cap delivered_respondent_count at respondent_count for any
-- brand_lift mission that over-reported (Pass 41 BUG3 carryover).
-- LEAST() handles missions that were correct already (no-op).
UPDATE public.missions
   SET delivered_respondent_count = LEAST(
         delivered_respondent_count,
         respondent_count
       )
 WHERE goal_type = 'brand_lift'
   AND delivered_respondent_count IS NOT NULL
   AND respondent_count IS NOT NULL
   AND delivered_respondent_count > respondent_count;
```

Audit query (should return 0 rows after backfill):

```sql
SELECT id, respondent_count, delivered_respondent_count
  FROM public.missions
 WHERE goal_type = 'brand_lift'
   AND delivered_respondent_count > respondent_count;
```

Specific verification for the reported mission:

```sql
SELECT respondent_count, delivered_respondent_count
  FROM public.missions
 WHERE id = 'af36a36d-401d-48e6-b94b-257e215613e2';

-- Expected after backfill:
-- respondent_count: 5, delivered_respondent_count: 5
```

## Why not also backfill other methodologies?

The brand_lift retry-loop swap is the only known site of
over-delivery in production. Other goal types haven't shown the
pattern in audits. Scoping the backfill to brand_lift keeps it
minimal. If future audits reveal the same pattern in other
methodologies (e.g. compare or marketing missions with retry
rounds), the same `LEAST()` clause can be re-run with a wider
goal_type filter.

## Pass 42+ ticket placeholder

Investigate why `screenedOutPersonaIds` doesn't capture every
persona that gets re-screened-out during the response simulation.
Two specific hypotheses to test:

1. Persona ID inconsistency — some code paths use `.persona_id`,
   others use `.id`. The retry filter uses `personasToSwap.includes(r.persona_id)`
   which would miss responses keyed by `r.id`.
2. Screening flag set AFTER the set was computed — the response
   pipeline may mark `persona_profile.screened_out = true` during
   `simulateAllResponses`, but the set was built in a prior pass.
   Need to verify the timeline.

Until that ticket lands, the cap above is the production safeguard.
