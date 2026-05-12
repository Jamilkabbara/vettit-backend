# Pass 34 C5 — Methodology e2e dry-run report

Run at: 2026-05-11T18:03:28.052Z

**Result: 11/11 fixtures valid for dry-run.**

| Methodology | goal_type | respondents | issues |
|---|---|---|---|
| Concept Test (validate) | `validate` | 100 | ✅ ok |
| Sequential Monadic (compare) | `compare` | 160 | ✅ ok |
| Ad Effectiveness (marketing) | `marketing` | 100 | ✅ ok |
| Creative Attention | `creative_attention` | 10 | ✅ ok |
| Van Westendorp + Gabor-Granger (pricing) | `pricing` | 150 | ✅ ok |
| MaxDiff + Kano (roadmap) | `roadmap` | 150 | ✅ ok |
| Brand Lift Study | `brand_lift` | 200 | ✅ ok |
| NPS + CSAT + CES (satisfaction) | `satisfaction` | 100 | ✅ ok |
| Brand Health Tracker (competitor) | `competitor` | 200 | ✅ ok |
| Naming & Messaging (monadic + paired + TURF) | `naming_messaging` | 320 | ✅ ok |
| Churn Driver Tree (churn_research) | `churn_research` | 100 | ✅ ok |

## Live runner (--run-all) status

Deferred to Pass 35. The live flow needs:
- Stripe test-card checkout via `/api/payments/create-intent`
- VETT100 promo code applied to drop total to $0
- Mission completion polling loop (30s × 60min cap)
- Insights JSONB shape assertions per methodology
- Cleanup hook to delete the test mission row + responses

Each full run costs ~$5-15 in Anthropic API spend.
