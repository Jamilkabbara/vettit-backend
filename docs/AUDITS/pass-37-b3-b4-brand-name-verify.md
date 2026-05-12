# Pass 37 B3+B4 — brand_name guard verification

## Verifies that Pass 35/36 fixes ship as expected when Pass 36+37 PRs merge

Both customer-facing methodologies that require a focal brand
(`satisfaction` / CSAT and `churn_research` / Churn) now reject
mission creation when `clarify.brand_name` is empty. The frontend
ALSO refuses to enable the launch CTA in the same case, so a user
should never see a backend rejection in practice.

## Backend guards (services/claudeAI.js)

Three methodologies have first-class brand_name refusals:

```
src/services/claudeAI.js:429   brand_lift     (Pass 34 B2)
src/services/claudeAI.js:909   satisfaction   (Pass 35 B3)
src/services/claudeAI.js:1749  churn_research (Pass 35 B4)
```

Each follows the same shape:

```js
const brand = (clarify?.brand_name || '').trim();
if (!brand) {
  throw new Error(
    '<methodology>: focal brand_name is required (received empty). ' +
    'Provide a focal brand in the setup form before generating the survey.',
  );
}
```

Error strings are stable so the frontend can pattern-match if we
ever want methodology-specific recovery UX. Currently the frontend
preempts the error entirely via methodologyReady.

## Frontend guard (src/pages/MissionSetupPage.tsx)

Pass 36 B3+B4 added the universal-inputs check to `methodologyReady`
for CSAT + Churn:

```ts
const universalEmpty = validateUniversalInputs(universalInputs).length > 0;
if (isCSAT)  return !universalEmpty && validateCSATInputs(csatInputs).length === 0;
if (isChurn) return !universalEmpty && validateChurn(churnState).length === 0;
```

`methodologyReady=false` keeps the ✦ Generate Survey CTA visually
disabled (`aria-disabled`, dimmed) so users see the gate even before
clicking. Click-time also fires a toast listing exactly which fields
are missing.

## Manual verification post-deploy

1. Land on `/setup`, pick "Customer Satisfaction" goal.
2. Fill the brief but leave the focal-brand input empty in
   UniversalMissionInputs.
3. Expect: ✦ Generate Survey CTA stays dimmed; clicking surfaces
   the toast "Brand name is required for CSAT".
4. Fill in the focal brand.
5. Expect: CTA enables; generation succeeds.
6. Repeat for "Churn Research".

## Why no new code in Pass 37

Pass 36 B3+B4 already shipped the frontend gate, Pass 35 B3+B4
already shipped the backend gate. Pass 37 only needs to verify the
combination ships intact once Pass 36 PR merges (Pass 37 branched
off Pass 36 so the commits ride along).

This doc captures the verification gate for the close-out audit.
