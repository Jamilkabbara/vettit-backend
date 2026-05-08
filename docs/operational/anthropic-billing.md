# Anthropic billing — operational runbook

**Owner:** Jamil
**Last updated:** Pass 35 E1 (2026-05-08)

## Why this matters

Every paid mission spends Anthropic API credits ($0.50-1.50 per
mission depending on methodology + persona count + chat usage).
The Pass 35 C5 dry-run runner doesn't spend; the Pass 36 live
runner will spend ~$5-15 per full sweep.

If the API balance hits $0, every running mission's persona
simulation step throws 402 → mission lands in `status='failed'`
→ Pass 34 C1 auto-refund fires → customer gets their money back
but the mission is dead.

This is operationally fixable in <5 minutes; the runbook below
keeps it from happening at all.

## Runbook

### Check balance

1. Open https://console.anthropic.com/settings/billing
2. Note the credit balance (top of page)

### Load credits

1. Same page → "Buy credits" or "Top up" button
2. Recommend $50-100 for Pass 35 → Pass 36 window:
   - Pass 35 ongoing API usage: ~$2-5/week at current scale
   - Pass 36 live runner: $5-15 per full sweep × 2-4 sweeps = $10-60
   - Buffer: $20+ for first 1-3 paying customers
3. Pay with the existing card on file (Visa ending in TBD per Stripe
   account)

### Enable auto-reload

1. Same page → "Auto-reload" toggle
2. Threshold: $10 (when balance drops below this, auto-charge)
3. Reload amount: $50

### Emergency runbook (if API returns 402)

If a mission fails with 402:

1. **Check live balance** at console.anthropic.com/settings/billing
2. **If $0**: load credits via the top-up button, wait 30s for
   propagation
3. **Re-trigger the failed mission** via admin "Reanalyze" button
   (Pass 27 admin feature) — this re-runs the simulation from
   the saved persona pool without re-charging the customer
4. **Verify completion** within 15 minutes
5. If the mission is unrecoverable: Pass 34 C1 auto-refund will
   handle it; admin notification fires

### Monitoring

The admin /ai-costs panel shows:
- Total cost over selected window (range: 30d / month / quarter / all)
- Daily Cost vs Revenue chart (Pass 33 W2)
- Per-mission rollup (Pass 33 W3)
- By-purpose bucket (Pass 34 C3) — chatbot / clarify / targeting
  spend separate from mission_pipeline

If cost spikes 3x in 24 hours: investigate via admin Operations
Breakdown table — likely a chat or clarify flow stuck in a retry
loop.

## What NOT to do

- Don't share the Anthropic API key. Service-role only, on Railway
  env. Rotate if leaked (GitGuardian incident handling per
  E2 runbook).
- Don't manually run unbounded scripts against the API. The
  test-all-methodologies runner enforces per-mission caps; ad-hoc
  Node scripts don't.
- Don't disable auto-reload — the cost of being out of credits at
  the wrong moment (paying customer, mid-mission) is much higher
  than $50 in unused balance.
