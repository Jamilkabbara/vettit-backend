# Honest Claims

**Last updated:** 2026-05-08 (Pass 33 W8 — peer-reviewed forward policy)

## Pass 33 W audit

A live audit of vettit.ai/methodologies (Pass 32 C1 production) surfaced
a NEW honesty regression that directly contradicted this doc:

**MethodologiesPage hero**: "Every VETT mission binds to a peer-reviewed
research methodology." — FALSE as worded. The frameworks (Van Westendorp,
MaxDiff, NPS, brand-health funnel, etc.) ARE peer-reviewed in the
academic literature. VETT outputs are synthetic-respondent simulations
of those frameworks; the simulation pipeline is not itself peer-reviewed.

Rewritten in Pass 33 W1 to:
> "Every VETT mission runs an industry-standard research framework. The
> methodologies themselves — Van Westendorp pricing, MaxDiff feature
> prioritization, NPS, brand-health funnel — are peer-reviewed in the
> academic literature. VETT outputs are synthetic-respondent simulations
> of those frameworks, not panel-grade truth."

Same correction pattern applied to `HelpPage.tsx` methodology answer
and `public/llms.txt` summary block.

**Forward policy (Pass 33+)**: any PR that applies "peer-reviewed" to
VETT outputs (vs. describing the framework itself) triggers a code-review
block. Same shape as the Pass 31 "real humans" forward policy. The
correct pattern is:

✅ "Van Westendorp is a peer-reviewed methodology"
✅ "VETT runs the peer-reviewed Van Westendorp battery"
✅ "MaxDiff is peer-reviewed in the academic literature; VETT
    simulates it with synthetic respondents"
❌ "VETT missions bind to peer-reviewed methodology"
❌ "VETT delivers peer-reviewed research"
❌ "Our peer-reviewed AI panel"

VETT does not produce peer-reviewed research. VETT runs frameworks
that are themselves peer-reviewed in the academic literature. The
output is a synthetic-respondent simulation of that framework's
instrument.

## Pass 31 Z1 + Z2 audit

A live audit of vettit.ai/about (Pass 30 production) surfaced two
FALSE claims that directly contradicted this doc:

1. **About page body**: "We use AI to formulate the strategy, but
   we use real, verified humans to give the answers." — FALSE.
   Rewritten in `vett-platform/src/pages/AboutPage.tsx` (Pass 31 Z1)
   to: "We use AI to build methodology-correct surveys and to
   simulate audience responses through synthetic respondents
   calibrated to real demographic patterns."
2. **About page "Real Humans" card**: "Every response comes from
   verified humans, not bots. We combine AI strategy with human
   insight for unbeatable accuracy." — FALSE on both counts.
   Replaced with "Methodology First" card whose body leads with
   the actual methodologies (Van Westendorp / MaxDiff / NPS /
   brand-health funnel) and ends with "The methodology is what
   makes the output trustworthy, not the panel."

**Z2 site-wide grep audit** (Pass 31) checked `src/`+`public/` for:
- "real human" / "verified human" / "human respondent" / "human
  panel" / "human insight" / "unbeatable accuracy" / "guaranteed
  accuracy" / "100% accurate" / "peer-reviewed" / "ISO certified"

Two false-positives surfaced and were rewritten:
- `ApiPage.tsx` hero subtitle: "Programmatic access to our panel
  of real humans." → "Programmatic access to methodology-correct
  synthetic research."
- `ApiPage.tsx` body: "...analyze sentiment from our verified
  human panel" → "...analyze sentiment using the same industry-
  standard methodologies (Van Westendorp, MaxDiff, NPS, brand-
  health funnel, ad effectiveness)..."

All other hits on `vs/*` / `terms-of-service.md` / blog drafts
were defensible — they accurately describe competitors as
human-panel and VETT as synthetic.

**Going forward**: any PR that adds a "human" / "real" /
"verified" / "100%" / "ISO" / "peer-reviewed" claim about VETT's
respondents triggers a code-review block. The Pass 31 Z1 fix is
the canonical example of how to rewrite for honesty without
losing the marketing punch.

Source-of-truth document for marketing copy, sales conversations,
investor materials, and any external content describing what VETT
does and doesn't do. Maintained as part of the engineering tree
because the line between "honest claim" and "stretch" is constantly
re-litigated and depends on the actual code that ships, not on the
copy department's preferred framing.

## ✅ Claims VETT can make

### Methodology fidelity

VETT runs industry-standard market research methodologies as
specified in their published references:

- **Van Westendorp Price Sensitivity Meter** — 4-question battery
  (too expensive / expensive but consider / bargain / too cheap),
  4-curve cumulative plot, PMC / PME / IPP / OPP intersections.
  Per Van Westendorp 1976, restated by Conjointly / Sawtooth public
  guidance.
- **Gabor-Granger** — 5-anchor price ladder, definitely-buy through
  definitely-not-buy 5-pt scale, demand × price = revenue curve.
  Per Gabor & Granger 1966, restated by current practitioner docs.
- **MaxDiff (best-worst scaling)** — 12 balanced 4-feature sets,
  best/worst within each set, utility = (best − worst) / (best +
  worst) normalized 0-100 across the feature list. Per Sawtooth /
  Conjointly published methodology.
- **Kano** — functional / dysfunctional pair per top feature,
  classified using the standard Kano matrix (Lee & Newcomb 1997
  modal-pair simplification) into Must-Have / Performance /
  Delighter / Indifferent / Reverse / Questionable.
- **NPS / CSAT / CES** — 0-10 / 5-pt / 7-pt scales scored as
  industry-standard (NPS = % promoters − % detractors; top-2-box
  for CSAT and CES). Bands per the published Bain / Forrester
  references.
- **Concept Test** — appeal / relevance / uniqueness / believability
  / purchase intent battery with industry top-2-box thresholds for
  launch-readiness. Standard pre-launch evaluation methodology.
- **Sequential Monadic** — each respondent sees concepts in
  randomized order, evaluates each on the same battery, then makes
  a forced choice. Per Drive Research / SurveyMonkey 2026
  practitioner guidance.
- **Ad Effectiveness** — recall, brand attribution, message
  takeaway, likeability, stopping power, distinctiveness, emotional
  response, persuasion shift. Kantar Link / ASI tradition.
- **Brand Lift Study with Incrementality** — paired exposed/control
  arms, funnel-staged 10-14 questions, lift = exposed − control.

### Synthetic respondent calibration

VETT generates synthetic respondents whose demographic distributions
(age / gender / income / location / behavioral habits) are
calibrated against published population-level data. Each respondent
is generated with a unique persona profile to avoid the "uniform
fallback answer" pattern that undermines naive LLM survey
simulation.

### Industry benchmark callouts

Every results page surfaces published benchmark thresholds inline
so the user sees how their score lands against typical performance:

- NPS bands (≥70 Excellent / 50-69 Great / 30-49 Good / 0-29 Fair
  / <0 Poor / <-10 Crisis) — Bain / Reichheld
- CSAT top-2-box bands (≥90 Excellent / 80-89 Great / 70-79 Good
  / 60-69 Fair / <60 Poor) — published practitioner norms
- CES top-2-box bands (≥85 Excellent / 75-84 Great / etc.) — Gartner
  / CEB
- Top-2-box concept appeal ≥40% = strong; intent ≥60% = launch-ready
- MaxDiff utility >65 strong, >80 winner, <15 noise
- Branded ad recall ≥40% strong; persuasion shift +0.5pt meaningful
- Sequential monadic: top-2 intent >60% launch-ready; win rate >55%
  clear preference

These thresholds come from published references and industry
practitioner guidance, not from internal calibration on VETT data.

### Speed and price

- Studies complete in minutes vs. weeks for traditional panels
- Pricing is per-respondent, not per-seat, with public tier
  ladders (see `vett-platform/src/utils/pricingEngine.ts` for
  current rates)

## ❌ Claims VETT CANNOT make

### Certifications and validations

- ❌ "ISO certified" — VETT has no ISO certification.
- ❌ "Peer-reviewed methodology validation" — no academic
  publication or peer-reviewed validation exists. The methodology
  fidelity claim is "we run the published method correctly", not
  "the academic community has verified our implementation".
- ❌ "Audited by [agency]" — no third-party audit has been
  commissioned.

### Accuracy / equivalence

- ❌ "100% accurate" — no research methodology, synthetic or
  human, can claim 100% accuracy. Synthetic respondents are
  directionally indicative.
- ❌ "Equivalent to real-customer panels" — synthetic respondents
  are calibrated to demographic distributions but cannot replicate
  every category-specific cultural nuance. For high-stakes
  decisions, the right framing is "directional pre-launch
  signal", not "panel replacement".
- ❌ "Guaranteed insights" — research results are statistical
  estimates with confidence intervals, not guarantees.
- ❌ Numerical accuracy claims like "94% correlation with real
  panels" — no such validation has been done.

### Competitor comparisons

When discussing competitors on `/vs/*` pages or in copy:

- ✅ Quote competitors' published pricing, methodology pages, or
  documentation. "Per <competitor>'s public pricing page" is the
  honest framing.
- ❌ Don't assert internal practices we can't verify (e.g.
  "<competitor> doesn't run Van Westendorp" — unless their public
  methodology page literally says so).
- ❌ Don't claim a competitor "doesn't have <feature>" without
  evidence. The conservative phrasing is "not advertised on their
  website as of <date>".

### Sample-size guarantees

- ❌ "Statistically significant at any sample size" — small-n
  studies are explicitly directional only. The
  `SampleSizeGuidance` component flags this in-app; marketing
  copy must do the same.

## Edge cases / FAQs

**Q: Can we say "research-grade"?**
A: Cautiously. The methodology fidelity claim is honest. The
implication "as good as a real research agency's panel" is not.
Prefer "industry-standard methodology" or "Conjointly-grade
methodology" (specific competitor reference) over the vague
"research-grade".

**Q: Can we say "MENA market expertise"?**
A: Yes. The channels_master + markets_master taxonomies cover
MENA more deeply than most synthetic-research competitors (see
`docs/CHANNELS_MASTER_LIST.md` and `docs/MARKETS_DIRECTORY.md`).
This is a real differentiator backed by code.

**Q: Can we cite specific studies the platform has run?**
A: Only with explicit customer permission. No anonymized customer
data should appear in marketing copy without a signed release.

**Q: How do we describe the synthetic-respondent generation?**
A: "AI-generated synthetic respondents calibrated to real-world
demographic patterns" is honest. "Indistinguishable from real
respondents" or "as good as human panels" is not.

## Update protocol

When a new methodology ships, update:
1. The "shipped methodologies" table in `METHODOLOGY_GUIDE.md`
2. The audit doc `MISSION_METHODOLOGY_AUDIT.md`
3. The relevant section here if the methodology fidelity claim
   needs new specifics

When a new claim is proposed in copy:
1. Map it to one of the categories above (✅ / ❌)
2. If novel, propose an addition to this doc in the same PR as
   the copy change
3. If contested, default to the more conservative phrasing
