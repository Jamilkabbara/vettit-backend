# Admin Costs Panel (Pass 24 Bug 24.02)

**Last updated:** 2026-05-05
**Path:** `/admin` → Analytics → Costs

## What it shows

Single-page dashboard for vendor + per-mission economics. Pinned to
admin user only via RLS on `vendor_costs` and `adminOnly` middleware
on `/api/admin/costs/*`.

Top to bottom:
1. **Header** with refresh + last-updated timestamp.
2. **Integrity warnings** (amber card, only when warnings exist).
3. **KPI row**: Revenue / Cost / Net contribution / Gross margin —
   each with MoM delta.
4. **Fixed monthly costs** (left): vendor table + edit pencil + total.
5. **Variable costs** (right): Anthropic by-model breakdown +
   estimated Stripe processing.
6. **Per-mission economics by goal_type**: paid count + revenue +
   avg per-mission. Revenue-gap warning when paid_missions > 0 but
   revenue = 0 (the known Stripe webhook bug).
7. **Capacity guardrails**: Supabase DB / Resend / Railway.

## Data sources

| Section | Source |
|---|---|
| Revenue (this/last month) | `missions.paid_amount_cents` (or `total_price_usd*100` fallback) where `paid_at` in window |
| AI cost (this/last month) | `ai_calls.cost_usd` summed in window |
| AI by-model (last 30d) | `ai_calls` grouped by `model` |
| Failed AI calls | `ai_calls` where `success = false` last 7 days |
| Stripe fees (estimate) | `paid_missions * 0.30 + revenue * 0.029` |
| Fixed monthly | `vendor_costs` rows where `category = 'fixed_monthly'` and `effective_to IS NULL` |
| Annual amortized | `vendor_costs` rows where `category = 'annual'`, divided by 12 |
| Per-goal-type table | `missions` grouped by `goal_type`, paid only |
| Supabase DB size | hardcoded 15 MB / 500 MB free tier (replace with live query in follow-up) |
| Resend / Railway | placeholder `null` (no API integrations this pass) |

## Updating vendor costs

**UI:** Costs tab → fixed-costs panel → pencil icon → modal → save.

**SQL:** point-in-time edits use `effective_from`/`effective_to`:
```sql
-- End the current row
UPDATE vendor_costs
SET effective_to = CURRENT_DATE, updated_at = NOW()
WHERE vendor = 'railway' AND effective_to IS NULL;

-- Insert the new rate
INSERT INTO vendor_costs (vendor, display_name, category, cost_usd, cost_unit, source, notes)
VALUES ('railway', 'Railway', 'fixed_monthly', 20.00, 'month', 'manual', 'Upgraded to Pro');
```

## Integrity warnings

| Code | Severity | Detection | Suggested action |
|---|---|---|---|
| `missing_paid_amount_cents` | critical | `paid_at IS NOT NULL AND paid_amount_cents IS NULL` | Fix Stripe webhook to populate `paid_amount_cents` on `payment_intent.succeeded` events |
| `failed_ai_calls` | warning (≥6 in 7d) | `ai_calls.success = false` in last 7 days | Check `ai_calls.error_message` for the failing model; retry |

## The Stripe paid_amount_cents bug (FLAGGED, NOT FIXED HERE)

Some `missions` rows have `paid_at IS NOT NULL` but
`paid_amount_cents IS NULL`. The webhook handler isn't writing the
amount to the DB on `payment_intent.succeeded`. The dashboard surfaces
this as a critical integrity warning AND falls back to
`total_price_usd * 100` for revenue calculation so aggregates aren't
zeroed out by the bug.

Separate ticket: fix `webhooks.js` payment-intent handler. Not in scope
for Bug 24.02 — this panel is observability-only.

## Endpoints

- `GET /api/admin/costs/dashboard` — single-call aggregation
- `GET /api/admin/costs/vendors` — list active rows
- `PATCH /api/admin/costs/vendors/:id` — update cost / notes / effective_to
- `POST /api/admin/costs/vendors` — create new vendor row

All gated by `authenticate + adminOnly` middleware (existing).
