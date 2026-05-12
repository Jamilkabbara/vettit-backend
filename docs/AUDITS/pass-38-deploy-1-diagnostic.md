# Pass 38 DEPLOY-1 — Backend deploy pipeline diagnostic (2026-05-12)

## TL;DR

The "deploy pipeline failure" rolling through Pass 36 → 37 → 38 is
**not** a Railway config bug, a webhook outage, or a CI failure. It
is a `git push` that was never executed.

Local git log shows 11 Pass 36 + Pass 37 commits on
`pass-37-verification-and-closure`. None of them ever reached origin.
Railway is correctly serving the most recent commit on `origin/main`
(`2e07f642`, Pass 35), because that is the only thing that ever got
shipped to it.

## Diagnostic commands run

```
$ cd /Users/jamilkabbara/vettit-backend
$ git rev-parse HEAD
d60c4bd28803269c92e9d78df8d109aaaf0483a3   ← Pass 37 E4 close-out

$ git rev-parse origin/main
2e07f642430a2eabe438cd1bbf29266b8806d27c   ← Pass 35

$ git log --oneline origin/main..HEAD | wc -l
11

$ git log --oneline HEAD..origin/main
(empty — origin is not ahead of local)

$ git ls-remote --heads origin | grep pass-3
981a493...    refs/heads/pass-36-demo-recovery   ← pushed but never merged
                                                     pass-37 branch ABSENT on origin
```

The 11 unpushed commits:
```
d60c4bd Pass 37 E4 — Close-out audit
1b48578 Pass 37 B3+B4 — brand_name guard verification audit
25c8646 Pass 37 A10 — Backend deploy verification CI
cba2990 Pass 37 A5 — Creative Attention stale-mission backfill SQL + audit
20a25e3 Pass 37 A0.0 — Deploy gate audit + bump /version to 37
981a493 Pass 36 E1+E4 — Admin alerts cleared + closeout audit + /version 36
cad457a Pass 36 A7 — README framework count: Pass 34 → Pass 36 reference
a8f26c6 Pass 36 A6 — Coverage gap dryrun report: pricing + naming + roadmap
69a37d5 Pass 36 A5 — Regression test: /api/missions list UUID/leak/shape
292ac7d Pass 36 A1 — /api/missions/:id distinct 401/403/404 + auth-race
a31a86d Pass 36 A0d backend — Stripe success_url → /processing/{id}
18d46c2 Pass 36 A0 — P0: delivered_respondent_count truth fix + backfill 11
```

(The `981a493` commit shows in this list because the Pass 36 branch
on origin stopped one commit short; that single commit plus
everything Pass 37 is what's missing.)

## Why this kept happening

Pass 36 and Pass 37 both wrote close-out audits that recorded the
local git state as "shipped" without ever curl'ing /version. Pass 37
A0.0 named this the deploy gate and codified Doctrine #17 ("shipped
= deployed, not merged"), but the close-out itself never ran the
gate. The doctrine described the requirement; the work to satisfy it
was never executed.

## Why pushes never ran

Most plausible: the assistant that produced Pass 36 + Pass 37 commits
operated inside a Claude Code worktree and made commits via direct
`git commit` rather than going through a `gh pr create` flow that
would have forced a push. Multiple `[branch sha] commit-message`
outputs from the prior session looked successful — they were, locally.
The `git push origin <branch>` step was simply never run.

This is a process bug, not a tooling bug. The fix is mechanical
(this commit + a `git push origin pass-38-deploy-first` afterward),
but the meta-fix is the Pass 38 verification CI (DEPLOY-4) which
fails fast on any close-out where /version doesn't match the merged
SHA.

## What Pass 38 DEPLOY-1 ships

1. `/version` bumped pass 37 → 38 in `src/app.js`. Three passes
   stacking the same bump would normally be wrong, but each prior
   bump was on a never-merged branch — by the time this PR merges,
   the live /version goes from 35 straight to 38, which correctly
   reflects what production is serving.

2. This audit doc captures the diagnostic + root cause so the
   pattern can't reoccur silently.

3. The branch this commit lands on (`pass-38-deploy-first`) is
   branched off `pass-37-verification-and-closure`, so all 11 prior
   unpushed commits ride along when this PR merges. Single merge →
   Pass 36 + 37 + 38 all reach production together.

## Verification (run AFTER push + merge + Railway redeploy)

```bash
curl -s https://vettit-backend-production.up.railway.app/version | jq .
# Expected: pass == 38
#           sha  == latest commit SHA on main after merge
```

If pass == 38 + sha matches, DEPLOY-1 verified.

If pass still 35: Railway auto-deploy did not fire. Check Railway
dashboard → vettit-backend service → Settings → confirm `main`
branch is selected for production environment and auto-deploy is
enabled. Manual fallback: `cd /Users/jamilkabbara/vettit-backend &&
railway up`.

## Push instructions for the user

After this commit lands on `pass-38-deploy-first`:

```bash
cd /Users/jamilkabbara/vettit-backend
git push origin pass-38-deploy-first
```

Then open a PR on GitHub (web UI):
- Base: `main`
- Compare: `pass-38-deploy-first`
- Title: `Pass 38 — Deploy Pipeline Recovery + Re-ship Pass 36/37 with Production Proof`
- Merge with "Create a merge commit" so the full 12-commit history is
  preserved on main.

After merge, watch Railway logs for the auto-deploy. Within ~3 min,
re-run the verification curl above.
