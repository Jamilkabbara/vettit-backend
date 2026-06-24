/* WO §2.3 — focal-brand resolution never emits the "Our Brand" placeholder. */
const { deriveFocalBrand, isGeneric } = require('../src/utils/focalBrand');
const { buildCanonicalReport } = require('../src/services/report/buildReport');
const { buildRenderModel } = require('../src/services/report/reportRenderModel');

describe('deriveFocalBrand', () => {
  test('uses the captured brand when present', () => {
    expect(deriveFocalBrand('Acme', 'whatever')).toBe('Acme');
  });

  test('never returns the "Our Brand" placeholder', () => {
    expect(deriveFocalBrand('Our Brand', '')).not.toBe('Our Brand');
    expect(deriveFocalBrand('our brand', '')).toBe('the brand');
    expect(deriveFocalBrand(null, '')).toBe('the brand');
    expect(deriveFocalBrand('', null)).toBe('the brand');
  });

  test('derives a quoted brand from the brief when unset', () => {
    expect(deriveFocalBrand(null, 'We are testing "Zephyr" against rivals')).toBe('Zephyr');
  });

  test('derives a "for X" brand from the brief', () => {
    expect(deriveFocalBrand('', 'Competitive study for Nimbus in the UAE')).toBe('Nimbus');
  });

  test('falls back to neutral when the brief has no clear brand', () => {
    expect(deriveFocalBrand(null, 'a study about the market')).toBe('the brand');
  });

  test('isGeneric flags placeholders', () => {
    expect(isGeneric('Our Brand')).toBe(true);
    expect(isGeneric('the company')).toBe(true);
    expect(isGeneric('Acme')).toBe(false);
  });
});

// §2.3 RENDER-TIME scrub — legacy competitor missions baked "Our Brand" into the
// stored analysis + survey text + answer labels + insights; the §2.3 generation
// fix never sanitised those, so they leaked on every surface. buildCanonicalReport
// now resolves a real focal label and scrubs the placeholder everywhere. Mirrors
// live mission 4515fed5 (no captured brand, no proper noun in brief → "the brand").
describe('competitor render scrubs the "Our Brand" placeholder on every surface', () => {
  const legacyMission = {
    id: 't', title: 'Ride-hailing benchmark', goal_type: 'competitor',
    brief: 'Benchmark our ride-hailing brand against Careem and Uber.',
    questions: [
      { id: 'q1', type: 'single_select', text: 'How likely are you to recommend Our Brand?', options: ['Our Brand', 'Careem'] },
    ],
    insights: {
      kpis: [{ title: 'Leading brand', value: 'Our Brand', trend: 'neutral' }],
      recommendations: ['Act on the headline finding (Focal brand: Our Brand) and review the survey.'],
      executive_summary: 'Our Brand trails Careem on reliability.',
    },
    analysis: {
      methodology: 'competitor', focal_brand: 'Our Brand',
      brands: [
        { label: 'Our Brand', is_focal: true, preference_pct: 20, nps: { score: -10 } },
        { label: 'Careem', preference_pct: 50, nps: { score: 30 } },
      ],
    },
  };
  const rows = [{ question_id: 'q1', answer: 'Our Brand', persona_id: 'p1' }];

  test('no surface in the render model contains "Our Brand"', () => {
    const rm = buildRenderModel(buildCanonicalReport(legacyMission, legacyMission.analysis, rows));
    expect(JSON.stringify(rm)).not.toMatch(/our brand/i);
  });

  test('unresolved focal resolves to the neutral fallback (no brand in brief)', () => {
    const rm = buildRenderModel(buildCanonicalReport(legacyMission, legacyMission.analysis, rows));
    expect(rm.headline.all.find((h) => /focal brand/i.test(h.label)).value).toBe('the brand');
  });

  // GUARD (a) — a properly-captured focal brand means EVERY string passes through
  // untouched: the scrub never engages, so an incidental "your brand" inside a
  // genuine verbatim/summary is NOT rewritten to the focal name.
  test('captured real brand → scrub never fires (incidental "your brand" survives)', () => {
    const captured = {
      id: 't2', title: 'T', goal_type: 'competitor', brief: 'Benchmark Swvl vs rivals',
      questions: [{ id: 'q1', type: 'open_text', text: 'What do you think of Swvl?' }],
      insights: { executive_summary: 'Respondents said they love your brand experience and would recommend it.' },
      analysis: {
        methodology: 'competitor', focal_brand: 'Swvl',
        brands: [{ label: 'Swvl', is_focal: true, preference_pct: 40 }, { label: 'Careem', preference_pct: 60 }],
      },
    };
    const rm = buildRenderModel(buildCanonicalReport(captured, captured.analysis, [{ question_id: 'q1', answer: 'I like your brand app', persona_id: 'p1' }]));
    expect(rm.headline.all.find((h) => /focal brand/i.test(h.label)).value).toBe('Swvl');
    // the incidental phrase is preserved verbatim — NOT turned into "Swvl experience"
    expect(JSON.stringify(rm)).toMatch(/your brand/i);
    expect(JSON.stringify(rm)).not.toMatch(/Swvl experience/i);
  });

  // GUARD (b) — even when the scrub IS active (generic focal), it only replaces
  // the whole-token placeholder, never a substring inside a longer word.
  test('whole-token only — "accompany" / "yourself" are not eaten', () => {
    const gb = { ...legacyMission, insights: { ...legacyMission.insights, executive_summary: 'We will accompany you; ask yourself about Our Brand.' } };
    const blob = JSON.stringify(buildRenderModel(buildCanonicalReport(gb, gb.analysis, rows)));
    expect(blob).toMatch(/accompany/i);     // "company" substring untouched
    expect(blob).toMatch(/yourself/i);      // "your" substring untouched
    expect(blob).not.toMatch(/our brand/i); // the whole-token placeholder IS replaced
  });

  test('does not mutate the caller\'s stored analysis (clone)', () => {
    const a = legacyMission.analysis;
    buildCanonicalReport(legacyMission, a, rows);
    expect(a.focal_brand).toBe('Our Brand'); // original untouched
    expect(a.brands[0].label).toBe('Our Brand');
  });
});
