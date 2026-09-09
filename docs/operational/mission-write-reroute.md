# Routing mission writes through the backend

**Status:** scoped, not started. Top engineering priority once the current
batch lands.

**Why it is not optional.** Three free-compute holes on the money path turned up
in a single session, and all three had the same root: the browser writes mission
rows directly to the database, so every server-side guard is advisory.

| found | what it was |
|---|---|
| the quote endpoint ignored goal type | the promo panel priced Creative Attention off the wrong ladder |
| the promo panel read the wrong field | every code, including a valid one, was rejected |
| the INSERT policy accepted all 118 columns | a user could create a row already marked running, then have a recovery sweep resume it for free |

Only the third was reachable for free compute, and it is now closed by an RLS
policy. But the policy is a patch over the shape of the system: `sanitizeClient
MissionPatch` on `PATCH /api/missions/:id` carefully denies `status` and the
money columns, and the app never calls that route. **A guard on a door nobody
uses is not a guard.**

## What writes to `missions` from a browser today

Two INSERT sites:

- `CreativeAttentionPage.tsx` - the whole Creative Attention creation flow
- `MissionSetupPage.tsx` - the main setup flow for every other goal type,
  and it sets `status`, `target_qualified_count` AND `ai_spend_ceiling_usd`
  from the client

Six UPDATE sites, all in `DashboardPage.tsx`: targeting (x3), questions,
respondent count + price estimate.

Current grants: INSERT covers all 118 columns; UPDATE was already narrowed to
four (`price_estimated`, `questions`, `respondent_count`, `targeting`).

## What the backend already has

`POST /api/missions`, `POST /api/missions/draft` and `PATCH /api/missions/:id`
all exist and are unused by the app.

`PATCH` is ready as-is: `CLIENT_PATCHABLE_COLUMNS` already lists all 60+ setup
fields both pages write, and `sanitizeClientMissionPatch` distinguishes
"unknown column" from "server owns this", which is the classification the
revocation depends on.

`POST` is the gap. Both create routes destructure only
`goalType / title / brief / questions / targeting / respondentCount`, so they
would silently drop everything Creative Attention needs (`media_type`,
`media_url`, `brand_name`, `desired_emotions`, `key_message`,
`brief_attachment`) and everything the setup page passes per-goal
(`mission_assets`, `category`).

## What breaks, and what does not

**Does not break:**

- Pricing. `calculateMissionPrice` returns $19 for Creative Attention at ten
  respondents with or without `mediaType`, because that ladder went
  respondent-based in Pass 25. Verified by execution.
- The methodology gate. Neither create route runs `validateMissionPricing`
  today, so re-routing cannot start refusing missions it used to accept. The
  gate still runs at checkout, which is where it belongs.
- Existing rows. Nothing here is a data migration.

**Does break, and needs handling:**

1. **The ceiling changes on the main flow.** `MissionSetupPage` currently sets
   `ai_spend_ceiling_usd` from its own client-side price estimate. `POST` derives
   it from the real engine. Those can disagree, and the server's number is the
   correct one - but it is a live behaviour change on every new mission, so it
   ships on its own and gets watched.
2. **The return shape.** Both pages use the inserted row immediately
   (`.select().single()` then `mission.id`). `POST` returns the row, so this is a
   shape check rather than a rewrite, but it is the thing most likely to produce
   a white screen if it is wrong.
3. **A new failure mode.** A direct database write is one hop; an API call adds
   a service that can be down. Mission creation is the product's primary action,
   so the error path needs to be as good as the happy path.

## Order

Each phase is independently shippable and independently revertible. Nothing is
revoked until the routes are carrying real traffic.

**Phase 0 - widen the create routes. Backend only, no user-visible change.**
Accept the per-goal creation fields through `sanitizeClientMissionPatch` so the
allowlist stays one list rather than two. Ship and sit.

**Phase 1 - move Creative Attention onto `POST`.** Smallest surface, one page,
and the path with the least traffic, so a mistake costs the least. Prove parity
against a real created mission before moving on.

**Phase 2 - move the main setup flow onto `POST`.** Carries the ceiling change
from breakage note 1. Ship alone.

**Phase 3 - move the six dashboard updates onto `PATCH`.**

**Phase 4 - prove it. This is the gate on Phase 5.**
Add a `created_via` column stamped by the backend. Any mission row that appears
without it is a client write the re-route missed. Watch for a week of real
traffic; the count must be zero before anything is revoked. Without this the
revocation is a guess.

**Phase 5 - revoke.** Drop the client INSERT grant to the columns a browser
still legitimately needs (or to none, if Phases 1-3 are complete), and narrow
the four remaining UPDATE columns. Only after Phase 4 reads zero.

## Do not

- Do not revoke before Phase 4. A revocation with a missed write path is an
  outage of the product's primary action, and it will present as "some users
  cannot create missions" rather than as an obvious failure.
- Do not collapse Phases 1 and 2. They fail differently: one is a rarely-used
  flow, the other is every mission on the platform.
- Do not treat the RLS policy added on 2026-09-09 as the fix. It blocks forged
  status and forged payment on insert, which closes the reachable hole. It does
  not stop a client setting its own `ai_spend_ceiling_usd` or
  `target_qualified_count`, and it never will - that is what routing the writes
  is for.
