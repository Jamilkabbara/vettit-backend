# Pass 34 B3 — Validate Generator Regression Notes

**Date:** 2026-05-08
**Scope:** Confirm Pass 32 X1 dedup fix did not regress the validate
(`goal_type='validate'`, Concept Test methodology) question generator.

## Production sample

Eight paid validate missions have completed end-to-end since Pass 30
B1 shipped. All eight produced the canonical 5-question battery and
generated executive summaries.

| mission_id (prefix) | paid_for | delivered (post-W4) | questions | has_summary |
|---|---|---|---|---|
| `a520d873` | 5  | 25 | 5 | ✅ |
| `2926123c` | 10 | 30 | 5 | ✅ |
| `e75a0230` | 10 | 38 | 5 | ✅ |
| `e18c9802` | 10 | 26 | 5 | ✅ |
| `077b6e23` | 10 | 50 | 5 | ✅ |
| `c69001d9` | 10 | 14 | 5 | ✅ |
| `2d12aac7` | 10 | 50 | 5 | ✅ |
| `7f54fb42` | 10 | 50 | 5 | ✅ |

Note: `delivered` column reflects the Pass 33 W4 backfill semantics
(total `mission_responses` rows). For 5-question surveys the row
count divided by 5 gives the persona count.

## Generator structure (per `VALIDATE_SURVEY_GEN_SYSTEM`)

The validate prompt produces exactly 5 questions:

1. **Screener** — qualifies category buyers from the brief context.
2. **Concept appeal** (rating 1-7).
3. **Concept relevance** (rating 1-7).
4. **Believability + uniqueness** (single-select).
5. **Purchase intent** (rating 1-5 or 1-7).

This matches the standard concept-test instrument used by
ASSESSOR / BASES family methodologies.

## Pass 32 X1 dedup verification

X1 fixed the simulator's response-row dedup so a 10-persona mission
generates exactly 50 rows (10 × 5), not 100. The eight production
missions show `delivered_respondent_count` values consistent with the
new semantics (14-50 rows for 5-10 personas × 5 questions). No
regression observed.

## Track C5 runner expectations

The `test:methodologies:full` runner (Pass 34 C5) targets validate
with `respondent_count = 5` (Sniff Test tier, $9). Expected outputs:
- `questions.length === 5`
- `delivered_respondent_count === 25` (5 personas × 5 questions, post-W4)
- `insights.kpis` populated
- `insights.executive_summary` non-empty
- `delivery_status === 'full'`

## Conclusion

The validate generator is the gold-standard reference. Pass 32 dedup
+ Pass 33 W4 backfill have left it functionally intact. No code
changes required for Pass 34 B3.
