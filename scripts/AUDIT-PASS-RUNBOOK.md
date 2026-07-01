# [AUDIT-PASS] live e2e runbook (owner-run, held)

Prove the LIVE path per research type (survey generation to persona simulation
to analysis to synthesis to report to export) on FRESH data, before any un-gate.
The offline harness already proved exports hold on stored data; this proves the
generation and simulation half.

## What this is (and is not)

- **Gate-safe, $0 to customers.** `test-run-all-types.js` inserts a `status=paid`
  mission directly and calls `runMission()` in-process. It imports no Stripe or
  payments module, opens no checkout, and never touches `src/config/comingSoon.js`.
  It un-gates nothing. LLM spend only.
- **Isolated.** Every mission is titled `[AUDIT-PASS] <goal> ...` and is swept in
  one pass by `purge-audit-pass.js`.
- **13 survey types.** `creative_attention` is excluded on purpose (asset/vision
  driven, zero survey responses) and stays on its own track.

## Cost (up front)

Audit-N sizing (market_entry 80, audience_profiling 60, research 100, all others
40). Estimated total **~$77** in Anthropic spend across the 13 (your ~$65-195
band). Estimate only; the runner reads **actual** `mission.ai_cost_usd` after each
run and prints a running total. Full fixture-N would be several times this.

## Run order

Pick a durable out-dir you can read afterward (not a session scratchpad):

```
OUT=~/vett-audit-out
```

### 0. Plan (no spend, no writes) — sanity check the cost/coverage
```
node scripts/test-run-all-types.js "$OUT" --plan
```

### 1. Canary — one cheap type, proves the whole chain end to end
```
node scripts/test-run-all-types.js "$OUT" --batch canary
```
Between-batch check before spending more:
- `c1 completes` = ok (status completed, no throw)
- `c2 survey` matches the goal
- `c3 personas` at/near target N
- `c4 analysis` populated (no gaps)
- `c5 exports` all clean (3 files written)
- Open `$OUT/validate_*.pdf|pptx|xlsx` and eyeball one.

If the canary is clean, proceed. If not, stop and send me `$OUT/_audit-summary.md`.

### 2. Small batch — the nine n=40 types
```
node scripts/test-run-all-types.js "$OUT" --batch small
```
Re-check `$OUT/_audit-summary.md` (accumulates across batches). Flag any row where
c1 fails, c2 says CHECK, c3 is far below target, c4 shows GAPS, or c5 shows ISSUE.

### 3. Large batch — audience_profiling (60), market_entry (80), research (100)
```
node scripts/test-run-all-types.js "$OUT" --batch large
```
Watch specifically: market_entry `c4` must show per-market demand_index AND a real
WTP band (no `WTP n/a` — the D3-class check on fresh data); audience_profiling `c4`
must show real segments (not aggregate-only).

Per-type or reduced-N reruns if needed:
```
node scripts/test-run-all-types.js "$OUT" --only market_entry
node scripts/test-run-all-types.js "$OUT" --only research --respondents 40
```

### 4. Rasterize + visual read (offline, no spend)
```
node scripts/export-acceptance-harness.js "$OUT/raster" $(cut -f2 "$OUT/_mission-ids.txt")
```
Renders + rasterizes all fresh exports to PNG for the same structural checks the §3
harness runs (0 dashes, editable PPTX, numbered recs, no collision) plus your eyeball.

### 5. Teardown — sweep prod clean when the read is done
```
node scripts/purge-audit-pass.js            # DRY RUN, lists what would go
node scripts/purge-audit-pass.js --apply    # delete all [AUDIT-PASS] missions + responses
```
(When P0-3 `purge-test-seed-data.js` merges, fold the same `[AUDIT-PASS]%` match
into it and retire `purge-audit-pass.js`.)

## Outputs on disk

- `$OUT/<goal>_<id8>.pdf|pptx|xlsx` — all three exports per type, off fresh data.
- `$OUT/_mission-ids.txt` — `goal<TAB>missionId` per line (feeds the raster harness).
- `$OUT/_audit-summary.json` / `.md` — the per-type 5-criteria grid + running spend.

## Un-gate stays held

This audit un-gates nothing. After a clean pass plus your and Jamil's research read,
un-gate one type at a time per the sequence in the market-entry un-gate map
(audience_profiling first, market_entry second, creative_attention last).
