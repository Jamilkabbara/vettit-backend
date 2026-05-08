# Pass 34 C6 — Methodology coverage audit (2026-05-08)

**Date:** 2026-05-08
**Source:** Pass 34 C5 dry-run + production paid-mission audit.

## Dry-run pass rate

11/11 fixtures valid. Each fixture exercises the methodology's
clarify-payload contract (per the question generator code in
`src/services/claudeAI.js`) and asserts the inputs the generator
needs to substitute brand/concept/candidate names verbatim.

See `scripts/test-results/methodology-dryrun-2026-05-08.md` for the
machine-generated table.

## Production paid-mission coverage

| `goal_type` | paid runs | completed | failed | with insights | Status |
|---|---|---|---|---|---|
| `validate` | 8 | 8 | 0 | 8 | LIVE-VERIFIED |
| `brand_lift` | 1 | 1 | 0 | 1 | LIVE-VERIFIED (Pass 34 B2 hardened) |
| `marketing` | 1 | 1 | 0 | 1 | LIVE-VERIFIED |
| `creative_attention` | 7 | 5 | 2 | 5 | LIVE-VERIFIED (2 failures reconciled by C1) |
| `compare` | 0 | — | — | — | UNVERIFIED |
| `pricing` | 0 | — | — | — | UNVERIFIED |
| `roadmap` | 0 | — | — | — | UNVERIFIED |
| `satisfaction` | 0 | — | — | — | UNVERIFIED |
| `competitor` | 0 | — | — | — | UNVERIFIED |
| `naming_messaging` | 0 | — | — | — | UNVERIFIED (Pass 34 B1 hardened) |
| `churn_research` | 0 | — | — | — | UNVERIFIED |

## Honest claim policy

Per HONEST_CLAIMS.md forward policy:

- **LIVE-VERIFIED**: methodology has at least one paid mission that
  completed end-to-end with insights generated. /methodologies marks
  these as live.
- **UNVERIFIED**: dry-run fixture passes but the methodology has
  never had a paid mission complete in production. /methodologies
  still marks these as live (because the question generator is
  shipped + tested manually) but Pass 35's live-runner sweep will
  retroactively flip any failure to UNAVAILABLE.

**No methodologies are currently flagged UNAVAILABLE** because the
Pass 34 C5 dry-run found 11/11 valid and no live-runner failures
have been observed (the live runner is deferred to Pass 35).

## What Pass 35 C5 must do

When the live runner ships, it should:

1. Fire VETT100-promo paid missions for each of the 7 UNVERIFIED
   methodologies using the C5 fixtures.
2. Poll completion (max 30 min per mission).
3. Assert the methodology-specific brand/concept/candidate name
   substitution per the C5 expected-behavior matrix.
4. If any methodology fails, file an admin_alert with
   `alert_type='methodology_e2e_test_failed'` and a payload pointing
   at the failed assertion.
5. Open a Pass 35 commit that flips the failed methodology to
   `comingSoon: true` in `src/data/missionGoals.ts` until the fix
   ships.

## Cost guardrail

Each full run is bounded at ~$5-15 in Anthropic API spend (11
methodologies × ~$0.50-1.50 per mission depending on respondent
count and methodology complexity). The runner script must require
an explicit `--run-all` flag (already enforced in C5) and must
short-circuit on Anthropic 429/500 retries to avoid runaway costs.
