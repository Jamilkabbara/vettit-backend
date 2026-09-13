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

---

## The three original holes: where each stands today

Checked against `origin/main` on 2026-09-10, not from memory.

**1. Reusable PaymentIntent — CLOSED, and closed well.**
`reconcileOrphanPendingPayment` will not accept a succeeded PI as proof that
THIS mission was paid. It requires `pi.metadata.missionId` to equal the
mission's own id, raises an admin alert on a mismatch rather than skipping
quietly, refuses a PI carrying no mission metadata at all, and checks the
captured amount actually covers what the mission owes. The code comment
describes the exact attack it defends: take your own succeeded PI id, paste it
onto a brand-new expensive mission, wait for the cron.

**2. Client-side paid marking — CLOSED.**
Two layers. The UPDATE grant on `missions` covers exactly four columns
(`price_estimated`, `questions`, `respondent_count`, `targeting`) — no status,
no money. And since 2026-09-09 the INSERT policy refuses a row that arrives
already carrying a status other than `draft`, a `paid_at`, a
`paid_amount_cents`, a `promo_code`, a `completed_at`, a `started_at`, or any
recorded spend.

**3. Creative Attention bypassing Stripe — NOT TRUE AS STATED, and the real
version is what this document is about.**
Creative Attention posts to the same `create-checkout-session`, gets the same
hosted Stripe Checkout, and is marked paid by the same webhook as every other
goal type. It never bypassed Stripe.

What it bypasses — along with the main setup flow — is the server-side mission
CREATE route. That is the actual defect, it is wider than Creative Attention,
and it is why the guards on `PATCH /api/missions/:id` are dead code.

## A cheaper option, evaluated: verify payment at the start of a run

Proposed as an alternative to, or a stepping stone before, the full re-route:
the backend refuses to start OR resume any mission unless it can verify payment
server-side, before any AI spend.

**What already exists.** `runMission` claims atomically on `status = 'paid'`, so
it does already refuse to run an unpaid row. The weaknesses are that `paid` is a
database flag rather than a verification, and that the resume path
(`runMission(id, {resume: true})`) bypasses the claim entirely by design —
that was the vector behind the forged-status hole.

**What the change is.** A single gate at the top of `runMission`, covering the
resume path too, that requires one of: a PaymentIntent whose metadata binds it
to this mission, whose status is succeeded, and whose captured amount covers
the price; or a free promo validated at the time it was applied and recorded on
the row; or an explicit admin override that is logged. The verification result
is cached on the row so a Stripe outage cannot become a mission-start outage.

**Cost: about three days.** Roughly one for the gate and its tests, half for
wiring it into the three entry points (normal start, resume, admin reanalyze),
half for the free-promo case which has no PaymentIntent to check, half for
validating it against every already-paid mission so it does not refuse
legitimate reruns, and half for live verification.

**What it does NOT close, and this is the point.** It stops free compute. It
does not stop the mission that RUNS from being a different mission than the one
that was PRICED:

- Roughly 110 columns are still writable at INSERT, including
  `target_qualified_count` and `ai_spend_ceiling_usd`. Someone can pay $9 and
  set the target to 1,250. Spend stays bounded, because checkout overwrites the
  ceiling server-side, but delivery is wrong and the customer is short-changed
  rather than the business being robbed.
- `respondent_count`, `questions` and `targeting` remain client-updatable after
  pricing, so the instrument that runs need not be the instrument that was
  quoted.
- Every guard on the API routes stays dead code, so the next person to add a
  money column has to remember a denylist nothing exercises.

**Recommendation.** Worth doing, and it is the right thing to reach for if the
re-route slips — three days buys the free-compute guarantee outright. But bank
it as containment, not as the fix. It makes the money safe while leaving the
correctness of what customers receive resting on the client behaving.
