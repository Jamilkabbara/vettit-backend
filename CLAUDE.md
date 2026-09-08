# Working agreement

## How to report to me

I am not an engineer. Reports that lead with code are reports I cannot act on.

- **Lead with what changed and what it means** for me or a customer, in plain
  language, before any detail.
- **No file paths, line numbers, commit SHAs or SQL** in the summary unless I
  ask for them.
- **Keep the technical detail**, but put it below the plain summary so I can
  skip it.
- **If something is broken, say what a customer would experience**, not what
  the code does. "Customers see a blank price" beats "the adapter returns
  EMPTY_SLOT".
- **End with one line: what you need from me, or "nothing needed".**

**Batch the work.** Take the whole queue, deploy as you go, report once at the
end. Interrupt me only for a decision or for something only I can do, such as
creating a mission, uploading a file, or approving a price.

## How to work

**Verify before asserting, including when the claim is mine.** Several times
this session I stated something confidently that the code contradicted: a
hardcoded promo default that was only comments, a navbar branch that looked
unreachable but was live on two pages, a "discarded" audience field that was
already wired. Check first. Being corrected costs a minute; building on a
false premise costs a day.

**Report before building on anything non-trivial.** Investigation is cheap and
often changes the plan. Twice the investigation showed the feature was already
built and only needed wiring.

**When I ask for something built on a premise that turns out to be wrong,
say so and propose the right fix instead of building what I asked for.** This
happened four times in one session and the correction was better every time.
I asked for a hardcoded promo default to be removed - it did not exist, and
the real hole was an internal code published on six public pages. I asked for
a navbar branch to be deleted - it was live, and deleting it would have
removed a working button. I asked for an audience field to be wired - it
already was, and a different field was the one being discarded. I asked for a
mission to be re-run - it was healthy and 42% done. Tell me what is actually
true, then tell me what you would do instead.

**Say when you cannot verify something.** An honest gap is worth more than an
invented mechanism. If a promo code appeared without explanation, the answer
is "I don't know how", not a plausible story about autofill.

## Before shipping

**Screenshot rendered output for anything visual.** Measurement alone misses
cosmetic defects. A grid fix that passed every numeric check still shipped an
empty cell rendering as a grey block and a number wrapping with one orphaned
digit. Numbers prove the absence of one failure; only looking proves the rest.

**Prove a test can fail.** Mutate the thing it protects and confirm it goes
red. A test that passes on both sides of the change is worse than no test,
because it reads as coverage. Watch for "Tests: 0 total" - that is a suite
that failed to load, not a suite that passed.

**An absence proof needs a positive control.** If you conclude something is
absent, show the same method returning present for a known-live case.
Otherwise you have proved only that your search does not work.

**A success flag is not proof.** A migration once returned success and changed
nothing. Always query the after-state.

## Production data

**Dry run first, and show me the statement before you run it.** Every write.

**Never rewrite what a customer bought.** Historical rows are the record. When
a guardrail blocks an edit to a paid row, that is the guardrail working.

**Bulk changes ship as a script I run**, with dry-run and real run sharing one
selection function, so the preview cannot drift from the execution.

## Deploying

**One at a time, with a live check after each.** Not a green build - an actual
request against the running site.

**Retarget stacked pull requests to main before their base merges**, or they
are auto-closed and cannot be reopened.

**After a squash merge, rebuild the branch** rather than rebasing. The squash
commit does not match the original history.

## Repository hygiene

**Never `git stash`** - the stash is shared across worktrees and other work
may be running.

**Commit and push early, even mid-task.** Interrupted work that was committed
survives. Uncommitted work does not, and `git checkout` silently restores to
the last commit, so verification afterwards may be testing the wrong code.

**Verify which commit you are working from** before analysing anything. Stale
checkouts have produced confidently wrong analysis more than once.

**Never `npm install` through a symlinked `node_modules`.**

**Copy `.env` into a worktree when you need to run the app, never commit it.**

## Things that stay true

**Statistical honesty.** All three of these were live defects found in one
session:

- Never claim a significance a sample cannot support. When the base is too
  small, the number is withheld and the reason is stated, not greyed out or
  quietly rounded.
- Never publish a benchmark we do not have the data for.
- Never name a model vendor on a customer-facing surface.

Other things that stay true:

- Public marketing pages must never publish an internal promo code.
- Copy that customers read uses hyphens, not em dashes or en dashes.
- Public prices must match what the pricing engine actually charges.
- Do not weaken row-level security.
- Never print an access token.

---

**This file exists identically in both repositories** - the website and the
backend. The rules govern how the work is done, not what either codebase
contains, so they must not diverge. If you change the doctrine in one, change
it in the other in the same session.
