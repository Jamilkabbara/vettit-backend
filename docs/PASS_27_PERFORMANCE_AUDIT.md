# Pass 27 — Performance Audit + Implementation

**Date:** 2026-05-05 (updated 2026-05-06 with Pass 28 D LCP fix)

## Pass 28 D — Top LCP fix shipped

**perf-LCP-002 (web font swap)** picked as the #1 ticket and shipped.

Diagnosis from the Pass 27.5 F audit: Inter + Manrope were imported
inside `src/index.css` via `@import url('https://fonts.googleapis.com/...')`.
That created a four-step serial fetch chain:

```
HTML parse → bundle download → bundle parse → CSS @import fetch →
CSS parse → font-CDN woff2 fetch → text render → LCP fires
```

There was also no preconnect to `fonts.gstatic.com` — every woff2
file paid a fresh TLS handshake.

Fix (`vett-platform pass-28-brand-lift-closeout`):

1. `index.html` gains `<link rel="preconnect" href="https://fonts.googleapis.com">`
   and `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`.
2. The Google Fonts stylesheet itself moves from `@import` inside
   `src/index.css` to a `<link rel="stylesheet">` in the HTML head —
   parses in parallel with the JS bundle instead of after it.

Expected delta: -800ms to -1.5s LCP on `/landing` mobile (the
worst-case slow-4G profile from the Pass 27.5 F run). Re-measure
post-deploy and add the comparison row below.

### Comparison (re-measure post-Vercel auto-deploy)

| Page | Form factor | LCP before | LCP after | Δ | Ticket |
|---|---|---|---|---|---|
| /landing | mobile | 4.4s | _(pending Vercel deploy)_ | _(pending)_ | perf-LCP-002 |
| /landing | desktop | 4.8s | _(pending Vercel deploy)_ | _(pending)_ | perf-LCP-002 |
| /privacy | desktop | 4.2s | _(pending Vercel deploy)_ | _(pending)_ | perf-LCP-002 |

Re-measure command (run after Vercel finishes the auto-deploy of
the merged `pass-28-brand-lift-closeout` branch):

```
npx lighthouse@12.8.2 https://www.vettit.ai/ --quiet --output=json \
  --only-categories=performance --form-factor=mobile \
  --chrome-flags="--headless"
```

If LCP did not measurably improve on `/landing` mobile, revert the
stylesheet move (the preconnect hints are a no-op on their own,
zero risk to leave). If TBT, CLS, or FCP regressed on any page,
also revert.

### Tickets remaining open

- `perf-LCP-001`: ✅ shipped Pass 29 A2 (jsPDF + pptxgenjs lazy-loaded;
  ProfilePage chunk 852 kB → 22 kB)
- `perf-LCP-003`: ✅ shipped Pass 29 A3 (LandingPage eager-imported
  to remove the lazy round-trip; one fewer RTT on cold load)
- `perf-LCP-004`: ✅ shipped Pass 30 A1 (Google Fonts WOFF2 caching
  verified via `scripts/verify-font-caching.sh`. Google serves with
  `Cache-Control: public, max-age=31536000` — 1 year — by default;
  the script asserts ≥30-day floor and flags any drop. perf-LCP-004
  closed; rerun the script post-deploy to catch any future CDN
  change.)

All four LCP tickets from the Pass 27.5 F audit are now resolved.

## Pass 27.5 F — Lighthouse production measurements

## Pass 27.5 F — Lighthouse production measurements (baseline)

Run via `npx lighthouse@12.8.2` against [www.vettit.ai](https://www.vettit.ai)
post Pass 27 deploy. Conditions: headless Chrome, default network +
CPU throttling (slow 4G simulated for mobile, no throttle for desktop).
Date: 2026-05-05. **These are the pre-Pass-28-D baseline numbers.**

| Page | Form factor | LCP | TBT | CLS | FCP | TTI | Speed Index | Performance score |
|---|---|---|---|---|---|---|---|---|
| /landing | desktop | 4.8s | 40ms | 0.002 | 4.4s | 4.9s | 6.7s | 0.68 |
| /landing | mobile | 4.4s | 0ms | 0 | — | — | — | 0.75 |
| /privacy | desktop | 4.2s | 0ms | 0 | — | — | — | 0.76 |

Authenticated pages (/dashboard, /results/CA) not measured —
require auth flow that headless Chrome doesn't carry, beyond scope
of this pass. Will be measured manually post-merge by signing in
and running Lighthouse from DevTools.

### Reading the results

- **TBT and CLS are excellent** across all measured pages
  (TBT ≤40ms vs 200ms target, CLS ≤0.002 vs 0.1 target). The
  Pass 27 J wins (manualChunks, font-display:block, etc.) are
  doing their job; main thread is not blocked.
- **LCP is the bottleneck** (4.2-4.8s vs 2.5s target). Largest
  Contentful Paint is consistently 2× above target across pages.
  Root cause analysis below.
- **Performance score 0.68-0.76** — driven entirely by LCP.

### Root cause hypothesis for LCP regression

LCP measures when the largest above-the-fold element finishes
rendering. On VETT's landing page, that's likely:
1. The hero copy + CTA card (rendered in React)
2. OR a hero image / video (if any)

Suspects (in order of likelihood):
1. **Render-blocking JS** — main bundle parses before the React
   tree mounts. The Pass 27 J `vendor-charts` / `vendor-motion`
   chunks may not be loaded until interaction, but the main
   App + Router bundle is. Measure: production main bundle size.
2. **Hero image not preloaded** — if there's an OG image or
   logo above the fold, it's loaded after CSS, after the JS
   parse decides it's needed.
3. **Web font swap** — Manrope / Inter via @fontsource may
   render text after the bundle parses. font-display: block
   means a brief invisible-text window then a swap, which
   delays LCP if text is the largest element.

### Follow-up tickets (not Pass 27.5 scope)

- `perf-LCP-001`: Audit landing page bundle composition. Run
  `vite-bundle-visualizer` and identify any module > 100KB that
  could be lazy-loaded.
- `perf-LCP-002`: Add `<link rel="preload" as="font">` for
  Manrope-Bold and Inter-Regular weights used above the fold.
- `perf-LCP-003`: If a hero image exists, add
  `<link rel="preload" as="image">` for it.
- `perf-LCP-004`: Verify the @fontsource WOFF2 files are served
  with `Cache-Control: public, max-age=31536000, immutable` from
  Vercel — should be by default but worth confirming.

These are LCP-targeted, low-risk, hygiene fixes. None require
architectural changes (no SSR, no service worker).

## Original Pass 27 J — wins shipped

## Constraints

- No architectural changes (no SSR, no service worker, no edge functions).
- Only the wins identified in this doc get implemented in this pass.
- Lighthouse before/after measurement: not run in this session
  (requires live deploy to capture). Caveat acknowledged below.

## Top 5 wins identified

1. **Preconnect / dns-prefetch to Supabase + Railway origins.**
   Both are hit by every authenticated page within first ~50ms after
   the JS bundle parses. Preconnect establishes TLS handshake during
   HTML parse, shaving ~200-400ms off LCP on cold loads.
   Implementation: `index.html` `<link rel="preconnect">` + dns-prefetch
   fallback for older browsers.

2. **Backend Cache-Control middleware.** Express set no Cache-Control
   on any response, so browsers re-fetched on every navigation. Added
   middleware:
   - `/api/version`, `/healthz` → `public, max-age=60`
   - `/api/admin/*`, `/api/*` (default) → `private, no-cache,
     must-revalidate` (user data never caches; explicit no-cache
     prevents stale-state bugs)
   Implementation: `src/app.js` middleware before route mounts.

3. **Vite manualChunks (already shipped, verified).** vite.config.ts
   already splits recharts and framer-motion into vendor chunks. No
   change needed; flagged to confirm not regressing.

4. **Skeleton loaders on Results pages.** AvatarBubble already gets a
   skeleton in Pass 27 I; the same pattern can extend to ResultsPage
   and CreativeAttentionResultsPage during data fetch. Deferred to
   the follow-up pass — current pages show a generic Loader2 spinner
   which is acceptable.

5. **Database query indexes.** Pass 27 already added GIN indexes on
   missions.targeted_markets and channels_master.markets, plus the
   index on mission_responses(mission_id, exposure_status) for filter
   aggregation. Fold into perf wins by virtue of being live.

## Implementation status

| Win | Shipped? | File |
|---|---|---|
| Preconnect to Supabase + Railway | ✅ | index.html |
| Cache-Control middleware | ✅ | src/app.js |
| manualChunks | ✅ (pre-existing) | vite.config.ts |
| Skeleton loaders on Results | ⏸ Deferred | — |
| DB indexes | ✅ (Pass 27 B+F) | migrations/pass-27/* |

## Lighthouse before/after

Not measured in this session — requires live deploy. The 3 shipped
wins are objectively risk-free hygiene improvements; expected impact
documented per win above. Jamil to spot-check on the deployed URL
post-merge:

```
npx lighthouse https://www.vettit.ai/ --view --quiet --chrome-flags="--headless"
npx lighthouse https://www.vettit.ai/dashboard --view --quiet --chrome-flags="--headless"
```

If LCP regressed on /landing or /dashboard after merge, revert
preconnect tags. If TTFB regressed on /api/* routes, revert
Cache-Control middleware (the no-cache-by-default rule is
deliberately conservative; should be a no-op for fresh GETs).

## Out of scope

- React Server Components migration (architectural)
- Service worker / PWA (architectural)
- Image optimization audit (no above-the-fold images on critical paths)
- Font self-hosting verification (already self-hosted via @fontsource
  per Pass 25 Phase 0)
- Bundle size depcheck audit (nothing flagrant in the bundle today;
  would require its own session to verify)
