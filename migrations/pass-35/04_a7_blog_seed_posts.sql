-- Pass 35 A7 — Blog: 3 SEO seed posts.
--
-- Pass 32 shipped blog infrastructure (table + routes + admin UI) but
-- never seeded content. /blog rendered "No posts yet" — bad for SEO,
-- looks unprofessional pre-sales.
--
-- 3 evergreen posts seeded, each tied to a methodology that's live
-- in production. Honest framing: synthetic respondents, methodology-
-- first, directional signal not statistical truth.
--
-- Apply via apply_migration as `pass_35_a7_blog_seed_posts`.

INSERT INTO public.blog_posts (
  slug, title, excerpt, body_markdown, tag, emoji,
  published, published_at, auto_generated
) VALUES
(
  'product-market-fit-synthetic-respondents-2026',
  'How to test product-market fit in 2026 with synthetic respondents',
  'Concept tests used to take weeks and thousands of dollars. Synthetic respondents collapse the loop to minutes for $9-99 — what changes, what stays the same.',
  '## Why concept tests still matter

Every founder knows the temptation: skip the research, ship the MVP, see what sticks. The problem is the answer arrives after months of build cost. A concept test gets you a directional read in hours. You learn whether the value proposition lands, whether pricing is in the right band, whether the message resonates — before you write a line of code.

The classic concept-test instrument (BASES, ASSESSOR, monadic acceptance) hasn''t changed in 30 years. What''s changed is who answers it.

## Synthetic respondents, not real panel

VETT runs concept tests with synthetic respondents — AI personas calibrated to the demographic and behavioral patterns of your target audience. That''s not the same thing as a real-panel study. We don''t recruit humans. The output is fast directional signal, not statistical truth.

Where this fits: pre-launch validation, naming and messaging iteration, low-stakes go/no-go calls. Where it doesn''t: regulated claims, scientific validation, anything where the deliverable needs panel-grade documentation.

## What a $9 Sniff Test actually shows

The minimum tier is 5 personas, $9. That''s enough to surface the strongest signal — does the concept have appeal at all, what''s the most-cited objection, which segment seems most engaged. It''s not enough to do statistically clean cuts; for that step up to the $99 tier (50 personas) or the $299 tier (250 personas).

The honesty check: if 5 personas reject the concept unanimously, that''s a signal. If they''re split 3-2, the test is too small to trust the split. Read the qualitative voice, not the percentages.

## When to combine with panel research

Pre-launch in MENA: VETT first to iterate cheaply, then a real-panel study via a regional research agency before committing media budget. The synthetic step saves 6-8 weeks of iteration cost; the panel step is the one that goes in the board pack.

## Try it

Drop a concept idea into [/setup](/setup) and you''ll have a 5-question survey + 5-respondent test in your inbox in about 10 minutes.',
  'Methodology',
  '🧪',
  TRUE,
  NOW(),
  FALSE
),
(
  'van-westendorp-pricing-saas-2026',
  'Van Westendorp pricing for SaaS: what $9-35 missions look like in practice',
  'The 4-question PSM battery + 5-anchor Gabor-Granger ladder, run on synthetic respondents. What you can actually learn at the entry tier — and what you can''t.',
  '## The instrument

Van Westendorp''s Price Sensitivity Meter (1976) asks four open-ended price questions. Gabor-Granger (1965) layers a 5-anchor purchase-intent ladder on top. Together they give you four reference points (PMC, PME, IPP, OPP) and a demand × price curve.

The math hasn''t changed. What''s new is being able to run it in 15 minutes against a defined audience for $99 instead of $5,000.

## Sample-size honesty

VETT''s pricing methodology has a 150-respondent floor (Van Westendorp + Gabor-Granger combined). Below that, the curves are too noisy to fit reliably. We surface this on the setup page; the floor isn''t arbitrary, it''s where the methodology stops being directional and starts being noise.

The $99 tier delivers 50 personas — useful for the qualitative open-text in question 4 ("how much would be too cheap?") but below the curve-fit floor. Step up to $299 (250 personas) for stable curves.

## What you actually get

The results page shows:
- All four VW curves overlaid (too expensive, expensive but consider, bargain, too cheap)
- Intersection points: PMC (point of marginal cheapness), PME (point of marginal expensiveness), IPP (indifference price), OPP (optimal price)
- Gabor-Granger demand curve with revenue-per-respondent overlay
- Per-question raw distributions

Direct read: optimal price is at the OPP intersection. Acceptable range runs PMC → PME. Anything below PMC reads as too cheap (quality concerns); anything above PME reads as too expensive.

## Limits

Synthetic respondents don''t have wallets. They don''t feel the price the way a real buyer does. What they DO carry is calibration on category-level willingness-to-pay benchmarks (training data on consumer pricing across categories). For commodity SaaS in established categories, that''s usually directionally right. For genuinely novel pricing (a category with no public benchmark), the signal is weaker — pair with a real-panel pass before launch.

## Try it

[Start a pricing mission](/setup?goal=pricing). Bring a 1-paragraph product description and a rough price band; the AI fills in the rest.',
  'Methodology',
  '💰',
  TRUE,
  NOW() - INTERVAL '1 day',
  FALSE
),
(
  'ad-creative-attention-frame-by-frame-2026',
  'Ad creative attention: replacing 4-week panel research with frame-by-frame AI',
  'Attention prediction at 24 emotion dimensions, distinctive brand asset scoring, channel fit benchmarks. What synthetic-respondent creative testing can and cannot do.',
  '## The traditional creative test

Pre-launch creative testing has historically meant a panel study: 200+ respondents, eye-tracking lab, 4-6 week turnaround, $15-30k. The output is a deck with attention curves, emotion scoring, and platform-fit recommendations.

Most early-stage and mid-market brands skip the test entirely because the cost-benefit doesn''t work. The result: ads ship that no one stress-tested.

## What frame-by-frame AI does differently

VETT''s Creative Attention pipeline:
- Vision-model scoring per frame (every second of video, every region of static creative)
- 24-emotion taxonomy (Plutchik 8 + 16 nuanced research-derived)
- Attention prediction calibrated to TVision / Lumen industry norms
- Distinctive brand asset score with read-time prediction
- Per-platform fit scoring (Instagram Reels, TikTok, YouTube, OOH, programmatic display)

What you upload: image or video. What you get back: a frame-by-frame breakdown, an executive summary, and a brand-aware export deck (PDF + PPTX + XLSX with the VETT brand tokens).

## Where it''s strong

Quick directional reads on whether the creative has stopping power, whether the brand reads in the first 1.5 seconds, which platforms it''ll work on, whether the emotional arc lines up with the campaign objective.

## Where it''s not the full answer

It''s not eye-tracking. It doesn''t measure actual viewer behavior; it predicts what a calibrated viewer would attend to based on visual structure, motion, and brand-asset cues. For high-stakes campaign decisions (multi-million-dollar media spend), pair with a real-panel attention study.

## What it costs

$19 per static image, $39 per video, $79 per 5-asset bundle, $249 per 20-asset series. The full report renders in ~3 minutes per asset.

## The honest pitch

If you''re shipping ads tomorrow and you didn''t do any pre-test, run a $19-39 Creative Attention pass first. It will catch the worst mistakes — wrong stopping moment, brand reads at frame 4 instead of frame 1, emotional arc inverted. It won''t give you the deliverable a brand-side researcher needs for an annual budget review. Different jobs, different tools.

## Try it

[Upload a creative](/creative-attention/new). 3-minute turnaround, branded export deck included.',
  'Methodology',
  '🎬',
  TRUE,
  NOW() - INTERVAL '2 days',
  FALSE
)
ON CONFLICT (slug) DO NOTHING;
