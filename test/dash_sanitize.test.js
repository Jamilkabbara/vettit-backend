/**
 * D7 — em/en dash "AI tell" scrub. Locks the product-wide rule: no em-dashes or
 * en-dashes anywhere in user-facing generated text (web report, exports, chat).
 *
 * Two layers under test:
 *   1. the deterministic sanitizer (sanitizeDashesString / sanitizeDashesDeep)
 *   2. the integration guarantee — buildCanonicalReport + buildRenderModel emit
 *      ZERO dashes even when the source insights/analysis/options are full of them.
 */

const {
  sanitizeDashesString,
  sanitizeDashesDeep,
} = require('../src/utils/textSanitize');

const NO_DASH = /[—–]/; // em (U+2014) or en (U+2013)

describe('sanitizeDashesString', () => {
  test('em-dash becomes a comma in prose', () => {
    expect(sanitizeDashesString('Buyers want speed — and they want it cheap.'))
      .toBe('Buyers want speed, and they want it cheap.');
  });

  test('en-dash becomes a hyphen in a price/number range', () => {
    expect(sanitizeDashesString('SAR 31–40')).toBe('SAR 31-40');
    expect(sanitizeDashesString('ages 25–44')).toBe('ages 25-44');
  });

  test('a trailing em-dash does not leave a trailing comma', () => {
    expect(sanitizeDashesString('That is the result —')).toBe('That is the result');
  });

  test('a lone em-dash placeholder collapses to empty, not a stray comma', () => {
    expect(sanitizeDashesString('—')).toBe('');
    expect(sanitizeDashesString(' – ')).toBe('-'); // a lone en-dash is a hyphen
  });

  test('double-dash spacing artifacts collapse cleanly', () => {
    expect(sanitizeDashesString('a — b — c')).toBe('a, b, c');
  });

  test('idempotent — scrubbing twice equals scrubbing once', () => {
    const once = sanitizeDashesString('Price band SAR 31–40 — strong demand.');
    expect(sanitizeDashesString(once)).toBe(once);
    expect(once).not.toMatch(NO_DASH);
  });

  test('null/number/undefined pass through untouched', () => {
    expect(sanitizeDashesString(null)).toBeNull();
    expect(sanitizeDashesString(42)).toBe(42);
    expect(sanitizeDashesString(undefined)).toBeUndefined();
  });

  test('a clean string is returned unchanged (fast path)', () => {
    const s = 'No dashes here, just commas.';
    expect(sanitizeDashesString(s)).toBe(s);
  });
});

describe('sanitizeDashesDeep', () => {
  test('scrubs nested string leaves in objects and arrays', () => {
    const out = sanitizeDashesDeep({
      title: 'Market entry — Gulf',
      findings: ['demand 31–40 band', 'no tell here'],
      nested: { note: 'strong — buy' },
    });
    expect(JSON.stringify(out)).not.toMatch(NO_DASH);
    expect(out.title).toBe('Market entry, Gulf');
    expect(out.findings[0]).toBe('demand 31-40 band');
    expect(out.nested.note).toBe('strong, buy');
  });

  test('scrubs OBJECT KEYS — distribution maps keyed by option labels', () => {
    const out = sanitizeDashesDeep({ distribution: { 'SAR 31–40': 24, 'SAR 41–50': 11 } });
    expect(Object.keys(out.distribution)).toEqual(['SAR 31-40', 'SAR 41-50']);
    expect(JSON.stringify(out)).not.toMatch(NO_DASH);
  });

  test('preserves numbers, booleans, and null; returns a fresh copy', () => {
    const input = { n: 80, ok: true, missing: null, label: 'a — b' };
    const out = sanitizeDashesDeep(input);
    expect(out.n).toBe(80);
    expect(out.ok).toBe(true);
    expect(out.missing).toBeNull();
    expect(out).not.toBe(input); // fresh copy, original untouched
    expect(input.label).toBe('a — b');
  });
});

describe('integration — canonical report + render model are dash-free', () => {
  const { buildCanonicalReport } = require('../src/services/report/buildReport');
  const { buildRenderModel } = require('../src/services/report/reportRenderModel');

  // A mission whose stored narration, analysis, and option labels are riddled
  // with em/en dashes — exactly the shape that leaked before D7.
  const mission = {
    id: 'test-d7',
    title: 'Concept test — Gulf launch',
    goal_type: 'general_research',
    status: 'completed',
    questions: [
      {
        id: 'q1',
        text: 'Which price band fits — pick one',
        type: 'single_select',
        options: ['SAR 31–40', 'SAR 41–50', 'SAR 51–60'],
      },
    ],
    insights: {
      executive_summary: 'Demand is strong — buyers cluster in the 31–40 band.',
      key_findings: ['Top band 31–40 — clear winner', 'Premium tier lags'],
      recommendations: ['Price at SAR 31–40 — capture the mode'],
    },
    analysis: { n: 3 },
  };
  const responses = [
    { persona_id: 'p1', question_id: 'q1', answer: 'SAR 31–40', screened_out: false,
      persona_profile: { age: 30, gender: 'female', country: 'SA', occupation: 'product manager — retail' } },
    { persona_id: 'p2', question_id: 'q1', answer: 'SAR 41–50', screened_out: false,
      persona_profile: { age: 41, gender: 'male', country: 'SA', occupation: 'analyst' } },
    { persona_id: 'p3', question_id: 'q1', answer: 'SAR 31–40', screened_out: false,
      persona_profile: { age: 35, gender: 'female', country: 'EG', occupation: 'buyer' } },
  ];

  test('buildCanonicalReport output contains no em/en dashes', () => {
    const report = buildCanonicalReport(mission, mission.analysis, responses);
    expect(JSON.stringify(report)).not.toMatch(NO_DASH);
  });

  test('buildRenderModel output contains no em/en dashes', () => {
    const report = buildCanonicalReport(mission, mission.analysis, responses);
    const model = buildRenderModel(report);
    expect(JSON.stringify(model)).not.toMatch(NO_DASH);
  });

  test('en-dash price ranges survive as hyphens (data preserved, just re-punctuated)', () => {
    const report = buildCanonicalReport(mission, mission.analysis, responses);
    const blob = JSON.stringify(report);
    expect(blob).toMatch(/SAR 31-40/); // the band is still there, now with a hyphen
  });
});
