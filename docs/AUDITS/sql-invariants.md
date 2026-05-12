# SQL invariants — verification queries

**Last updated:** Pass 36 A0 (2026-05-11)

## Doctrine #16 (new in Pass 36)

**SQL invariants must compare to GROUND TRUTH not derived columns.**

The Pass 33 W4 verification SQL was tautological — it compared
`delivered_respondent_count` against the same `COUNT(*) FROM
mission_responses` that the column itself was derived from. Result:
0 broken rows always reported, even though the column was lying.

May 11 2026 demo failure root cause: every paid mission overstated
respondent count by 2-10x because the column counted ROWS (personas
× questions) instead of distinct personas. Real customers were
getting "you got 25 respondents" messages when they paid for 5.

Going forward: every invariant in this file MUST compare the stored
value against an independent ground-truth derivation. NEVER against
the same expression that wrote the value.

## Invariants (must all return 0 broken rows)

### W4 (Pass 36 A0 corrected) — delivered_respondent_count truth

```sql
SELECT COUNT(*) FROM (
  SELECT m.id FROM missions m
  WHERE m.paid_at IS NOT NULL
    AND m.status = 'completed'
    AND m.goal_type != 'creative_attention'
    AND m.delivered_respondent_count != (
      SELECT COUNT(DISTINCT persona_id)
      FROM mission_responses mr
      WHERE mr.mission_id = m.id
    )
) s;
```

CA missions excluded — delivery_unit='creative_asset' has no
respondent rows by design.

### C1 (Pass 34) — failed missions reconciled

```sql
SELECT COUNT(*) FROM missions
WHERE status = 'failed'
  AND paid_at IS NOT NULL
  AND partial_refund_id IS NULL
  AND delivery_status NOT IN ('failed_admin_test_no_refund', 'failed_full_refund');
```

### C2 (Pass 34) — delivery_status not lying

```sql
SELECT
  COUNT(*) FILTER (
    WHERE delivery_status = 'partial'
      AND delivered_respondent_count >= respondent_count
  ) AS lying_partial,
  COUNT(*) FILTER (
    WHERE delivery_status = 'full'
      AND delivered_respondent_count < respondent_count
      AND goal_type != 'creative_attention'
  ) AS lying_full
FROM missions
WHERE paid_at IS NOT NULL AND status = 'completed';
```

### C3 (Pass 34) — ai_calls attribution

```sql
SELECT COUNT(*) FILTER (
  WHERE mission_id IS NULL AND purpose IS NULL
) AS truly_unattributed
FROM ai_calls
WHERE created_at > NOW() - INTERVAL '1 day';
```

### C4 (Pass 34) — mission_completed event coverage

```sql
WITH expected AS (
  SELECT COUNT(*) AS n FROM missions
  WHERE status = 'completed' AND paid_at IS NOT NULL
),
bound_events AS (
  SELECT COUNT(DISTINCT fe.mission_id) AS n
  FROM funnel_events fe
  INNER JOIN missions m ON fe.mission_id = m.id
  WHERE fe.event_type = 'mission_completed'
    AND m.status = 'completed'
    AND m.paid_at IS NOT NULL
)
SELECT (SELECT n FROM expected) AS expected,
       (SELECT n FROM bound_events) AS actual,
       (SELECT n FROM expected) - (SELECT n FROM bound_events) AS gap;
```

`gap` must be 0.

## Running the invariants

Run all five via the Supabase MCP `execute_sql` after every
migration that touches missions / mission_responses / ai_calls /
funnel_events. Pass-N close-out audit should include a snapshot of
each invariant's result.
