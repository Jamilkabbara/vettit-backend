# Pass 37 A0.0 — Deploy gate audit (2026-05-12)

## Finding: Pass 36 never merged to main

The Pass 36 close-out report claimed 14 commits shipped. Live Chrome
audit and git history check on May 12 found:

```
Frontend origin/main HEAD:  9913cff (Pass 35 PR #17 merge)
Backend origin/main HEAD:   2e07f64 (Pass 35 PR #14 merge)
Live /version response:     pass: 35, SHA 2e07f642430a2eabe438cd1bbf29266b8806d27c
```

Both Pass 36 PRs (`pass-36-demo-recovery` branches on both repos)
exist with all 14 commits present, but were never merged. The
"frontend deployed but visible bugs persist" claim in the Pass 37
spec is mis-attributed: the bugs persist because Pass 36 frontend
ALSO never deployed.

## Doctrine #17 (new in Pass 37)

**"Shipped" = deployed in production, NOT merged to main.**

Every future pass close-out audit must verify:
1. PR merged to main on the relevant repo
2. CI build green
3. Production deploy completed (Vercel for frontend, Railway for
   backend)
4. Live verification URL responds with the expected new state

A merged-but-not-deployed PR is **not shipped**.

## Doctrine #18 (new in Pass 37)

**Frontend "shipped" requires user-visible screenshot, not just
green CI.**

Pass 36 A0c created `ResearchResultsPage.tsx` and registered the
route in `ResultsRouter`. The file exists in git; the test page
in production still has the same empty-gap bug. Future frontend
close-outs require an embedded screenshot of the user-visible
behavior post-deploy.

## What Pass 37 carries forward

This branch (`pass-37-verification-and-closure`) is created OFF
`pass-36-demo-recovery` so all 14 Pass 36 commits ride along when
this PR merges. The user merges this single PR, both passes ship
together, Railway auto-deploys (or Pass 37 A10 GitHub Action
catches a deploy failure post-merge).

## A0.0 commit content

- `/version` pass field bumped 36 → 37
- This doc captures the deploy-gate state at pass-37 cut time
- Doctrines #17 + #18 codified for future pass close-outs

## Verification gate (manual, after Pass 37 PR merges)

```bash
curl -sS https://vettit-backend-production.up.railway.app/version | jq .pass
# Expected: 37
```

If the curl returns 35 or 36, Railway did not auto-deploy and the
user must manually trigger via Railway dashboard or `railway up`.
