# Pass 37 — Verification & Closure close-out (2026-05-12)

## TL;DR

Pass 37 carries forward the Pass 36 commits that never merged + ships
10 user-facing critical fixes (Track A) + verification audits for
Pass 35/36 work that was claimed shipped but unverified (B3+B4).
Both Pass 37 PRs (frontend `pass-37-verification-and-closure` on
vett-platform, backend same branch name on vettit-backend) are
branched off `pass-36-demo-recovery` so all 14 Pass 36 commits ride
along when this PR merges.

**Both PRs must merge together.** Frontend Pass 37 references
backend-only behavior (e.g. the A4 PENDING_PAYMENT auto-pay flow
relies on `/api/payments/create-checkout-session` being available);
backend Pass 37 ships nothing user-visible without the frontend.

## What shipped (Track A — 10 commits + 1 deploy-gate)

| Commit | Repo | What & why |
| --- | --- | --- |
| `20a25e3` A0.0 | backend | Deploy gate audit + `/version` pass:36 → 37. Doctrines #17 + #18 codified. |
| `577f0a9` A1 | frontend | ResearchResultsPage: KPI strip always renders (mission-level fallback) + tight layout. |
| `7943524` A2 | frontend | Dashboard MissionCard: respondents-delivered suffix reads `delivered_respondent_count`. |
| `c6dfe20` A3 | frontend | 4-12h ETA audit — JSX strings already removed by Pass 36 A0e; only comments remain. |
| `8661034` A4 | frontend | PENDING_PAYMENT card status-driven CTA + auto-pay via `?action=pay`. |
| `3b3622f` A5 | frontend | CreativeAttentionResultsPage: stale-mission failure UI + 30-min staleness check. |
| `cba2990` A5 | backend  | CA stale-mission backfill SQL audit. |
| `6218da0` A6 | frontend | Anonymous `/dashboard` bounces to `/signin?redirect=/dashboard`. MOCK_MISSIONS removed. |
| `cc07ad7` A7 | frontend | AccountTab profile-completeness banner with 4-field progress indicator. |
| `46ce811` A8 | frontend | Landing pricing single source: `STARTING_PRICE_USD` derived from `VOLUME_TIERS[0]`. |
| `82919a5` A9 | frontend | Dashboard skeleton: brand canvas `#0B0C15` + auth-aware paint chain. |
| `25c8646` A10 | backend  | `/version` post-merge verification CI workflow. |
| `331fde7` A10 | frontend | Vercel post-merge SHA verification CI workflow. |
| `1b48578` B3+B4 | backend | CSAT/Churn brand_name guards verification audit. |

Frontend: 10 commits. Backend: 4 commits. Total: 14 Pass 37 commits
on top of 14 Pass 36 carryover commits = 28 commits in the combined
merge.

## Doctrines added this pass

### Doctrine #17 — "Shipped" = deployed in production

A merged-but-not-deployed PR is **not shipped**. Every future
close-out must verify all four:

1. PR merged to main on the relevant repo
2. CI build green
3. Production deploy completed (Vercel for frontend, Railway for
   backend)
4. Live verification URL responds with the expected new state

Backend verification: `curl /version | jq .pass` matches expected.
Frontend verification: served HTML at vettit.ai references the
merged commit SHA OR a manual screenshot of user-visible new
behavior is attached.

### Doctrine #18 — Frontend shipped requires user-visible screenshot

Green CI ≠ deployed. Pass 36 A0c registered the `/results/:id`
route in git but the route never reached production because Pass
36 never merged. Future frontend close-outs require an embedded
screenshot showing the user-visible behavior post-deploy.

## Tooling that enforces the doctrines

| Tool | Repo | Purpose |
| --- | --- | --- |
| `/version` endpoint | backend | Exposes `pass: <N>` for live diff |
| `.github/workflows/verify-deploy.yml` | backend | Polls /version after merge, fails CI if pass doesn't match src/app.js |
| `.github/workflows/verify-deploy.yml` | frontend | Polls vettit.ai HTML for merged SHA after merge |
| Manual screenshot in PR close-out | both | The user-visible gate |

## Deferred (intentionally, documented)

| Track | Item | Reason | Reference |
| --- | --- | --- | --- |
| B1 | Audience Profiling full impl | Multi-week effort, partial scaffold acceptable for now | Pass 36 B1 defer doc |
| B2 | Market Entry full impl | Multi-week effort, partial scaffold acceptable for now | Pass 36 B2 defer doc |
| C1-C5 | Live runner + paid runs (pricing/naming/roadmap) | Cost-sensitive, manual QA gate before automated runs | Pass 36 C1 defer doc |
| D1-D7 | Mobile app | Out of scope for this pass; web app priorities first | Pass 36 D1 defer doc |
| E1 | CA pipeline catch-path hardening | Tracked as backend ticket; A5 frontend safety net mitigates | Pass 37 A5 audit doc |
| E2-E3 | Operational alert cleanup beyond E4 | Pass 36 E1 already cleared 8 stale alerts | Pass 36 E1 closeout |

## Verification gate (manual, after Pass 37 PR merges)

### Backend

```bash
# 1. Confirm /version reports 37
curl -sS https://vettit-backend-production.up.railway.app/version | jq .pass
# Expected: 37

# 2. Confirm CA backfill ran (after manual SQL apply per A5 audit doc)
# This requires Supabase access — skip if not the deployer.
psql -c "SELECT count(*) FROM public.missions
         WHERE goal_type = 'creative_attention'
           AND creative_analysis IS NULL
           AND status NOT IN ('completed', 'failed')
           AND created_at < NOW() - INTERVAL '1 hour';"
# Expected: 0

# 3. Confirm GitHub Action ran green on the merge commit
gh run list --workflow=verify-deploy.yml --limit 1
```

### Frontend

1. Visit https://vettit.ai/dashboard while signed out → expect
   redirect to /signin (Pass 37 A6).
2. Sign in, create a draft mission, navigate to the dashboard, see
   the mission card with status-driven CTA (Pass 37 A4).
3. Visit any completed mission's /results/:id → KPI strip is always
   visible at the top, never an empty gap (Pass 37 A1).
4. Visit landing page → search for "$35" via DevTools, should only
   appear in the Validate-tier label, never in starting-price copy
   (Pass 37 A8).
5. Account Settings → if profile is incomplete, banner appears at
   top with X/4 progress indicator (Pass 37 A7).

## If the verification gate fails

A failed /version curl means Railway didn't auto-deploy. Run:

```bash
railway login
railway link
railway up
```

Or trigger via the Railway dashboard. The A10 workflow will re-run
on the next push so you'll get an automated green signal.

A failed frontend HTML check usually means Vercel needs a manual
redeploy from the dashboard. The A10 frontend workflow soft-fails
(warning only) because the SHA-in-HTML heuristic has false
negatives — the manual screenshot remains the authoritative gate.

## Branch / PR state at close-out

Both repos:
  - Branch: `pass-37-verification-and-closure`
  - Branched from: `pass-36-demo-recovery` (so Pass 36 commits ride)
  - Merges to: `main`
  - Target: single PR per repo, merged together

Pass 36 PRs themselves can be closed without merging once Pass 37
merges — the commits arrive via the Pass 37 PR.
