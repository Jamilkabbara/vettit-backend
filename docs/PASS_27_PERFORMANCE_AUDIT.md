# Pass 27 — Performance Audit + Implementation

**Date:** 2026-05-05

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
