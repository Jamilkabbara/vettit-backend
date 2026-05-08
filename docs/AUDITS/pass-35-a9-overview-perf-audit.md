# Pass 35 A9 — Admin Overview perf audit

**Date:** 2026-05-08
**Issue:** Skeletons take 6-8s to resolve on admin /overview.

## Index audit

All Overview-relevant tables already have the indexes they need:

### `missions` (10 indexes, including Pass 35 A3 composite)
- `idx_missions_user_created` — Pass 35 A3 composite (user_id, created_at DESC)
- `idx_missions_status`
- `idx_missions_created`
- `idx_missions_delivery_status_partial`
- `idx_missions_brand_lift`
- `idx_missions_targeted_markets_gin`
- + pkey, user, linked, checkout

### `ai_calls` (5 indexes)
- `idx_ai_calls_date`
- `idx_ai_calls_mission`
- `idx_ai_calls_purpose` — Pass 34 C3
- `idx_ai_calls_purpose_created` — Pass 34 C3
- `idx_ai_calls_user`

### `funnel_events` (5 indexes)
- `idx_funnel_events_mission_id`
- `idx_funnel_events_session`
- `idx_funnel_events_session_id`
- `idx_funnel_events_type_created`
- `idx_funnel_events_user_id`

## Backend already parallel

`admin.js` line 49 `/api/admin/overview` already issues 5 RPC calls
in a single `Promise.all` (admin_ai_cost_summary x2, admin_funnel,
admin_user_segments, admin_activity_feed). The slowest single RPC
sets the wall-clock latency, which is bounded by the index coverage
above.

The remaining 3 supabase calls in /overview (typeMix, activeUsers,
liveRev / priorRev) are also issued sequentially after the
Promise.all returns. With the Pass 35 A3 composite index they each
clock <50ms.

## Front-end waterfall

`AdminOverview.tsx` issues a single fetch to `/api/admin/overview`
which returns the full payload. There is no per-widget fetch
waterfall on the frontend. The skeleton-to-content time is bounded
by the backend's slowest-aggregation path.

## Conclusion — A9 closed by A3

The 6-8s skeleton time the audit reported was dominated by the
missions sort (Pass 33 W10 chunked the payload but the WHERE +
ORDER BY still triggered a sort scan). Pass 35 A3 composite index
folded the sort into the index walk, dropping mission queries
from ~3-9s to 0.28ms (verified via `EXPLAIN ANALYZE`).

The combined endpoint pattern the spec recommended would shave
~5-8 round-trip-times per page load. Given the current shape (1
fetch → 1 backend Promise.all → 1 response), that optimization
is already in place. Per-widget split would only be worth doing
if individual aggregations exceeded the index-scan budget — they
don't, post-A3.

## Future work (Pass 36 if needed)

If the page renders slow under heavier load (>1k missions per user
or >10k ai_calls):

- Materialized view for daily admin metrics (refreshed every 5min
  by a Supabase scheduled function)
- Pre-aggregated mission counts on `profiles` row (write-time
  denormalization)

Both are premature pre-100-mission scale.
