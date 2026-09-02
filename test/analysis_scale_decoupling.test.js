/**
 * Pass 51 — scoring must not depend on hard-coded English option labels.
 *
 * Six analysis modules re-derived meaning by string-matching literal labels
 * ('Satisfied', 'Definitely would buy', answer === 'yes', option.includes
 * ('yes')). The generators emit exactly those labels today, so nothing was
 * mis-scored in production — this is hardening against drift, not a live bug.
 *
 * The failure mode it guards: off-scale answers stay in the DENOMINATOR while
 * never counting as top-box, so the module reports a confident 0.0% against a
 * full, healthy-looking n. Kano and Gabor-Granger already fail loudly in that
 * situation; these six failed silently and wrongly.
 *
 * Two properties are pinned here:
 *   1. REWORDED OPTIONS still score correctly, because the top box is taken
 *      positionally from the question's own options array (compare.js:207-211's
 *      rule) once the methodology tag, type and option count all match.
 *   2. When positional recovery is impossible — the ANSWERS themselves drifted
 *      off the scale — the zero is SURFACED (flag + warn) instead of charted.
 */

const { computeSatisfaction } = require('../src/services/analysis/satisfaction');
const { computeValidate } = require('../src/services/analysis/validate');
const { computeMarketEntry } = require('../src/services/analysis/marketEntry');
const { computeChurn } = require('../src/services/analysis/churn');
const { computeMarketing } = require('../src/services/analysis/marketing');
const { computeBrandLift } = require('../src/services/analysis/brandLift');
const { resolveBoxSet, offScaleCount, auditZeroBox } = require('../src/services/analysis/shared');

const N = 20;
const rep = (arr, n) => Array.from({ length: n }, (_, i) => arr[i % arr.length]);
const rows = (qid, answers) => answers.map((a, i) => ({ persona_id: `p${i}`, question_id: qid, answer: a }));

const CSAT_CANON = ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'];
const CSAT_REWORD = ['Not at all satisfied', 'Slightly satisfied', 'Moderately satisfied', 'Quite satisfied', 'Extremely satisfied'];
const INTENT_CANON = ['Definitely would buy', 'Probably would buy', 'Might or might not', 'Probably would NOT buy', 'Definitely would NOT buy'];
const INTENT_REWORD = ['Certain to buy', 'Likely to buy', 'Unsure', 'Unlikely to buy', 'Certain not to buy'];

// 4 of every 5 respondents answer in the top-2 box → 80% whatever the wording.
const topHeavy = (opts, idx) => rep(idx.map((i) => opts[i]), N);

describe('resolveBoxSet — the guard, not just the result', () => {
  const base = { tag: { key: 'methodology', value: 'csat' }, type: 'single', size: 2, expectedLength: 5, from: 'tail', fallbackLabels: ['Satisfied', 'Very satisfied'] };

  test('canonical shape → positional, top-2 taken from the TAIL', () => {
    const r = resolveBoxSet({ ...base, question: { methodology: 'csat', type: 'single', options: CSAT_REWORD } });
    expect(r.basis).toBe('positional');
    expect(r.labels).toEqual(['Quite satisfied', 'Extremely satisfied']);
  });

  test('from:head takes the other end — direction is not guessable', () => {
    const r = resolveBoxSet({
      question: { funnel_stage: 'intent', type: 'single', options: INTENT_REWORD },
      tag: { key: 'funnel_stage', value: 'intent' },
      type: 'single', size: 2, expectedLength: 5, from: 'head', fallbackLabels: [],
    });
    expect(r.labels).toEqual(['Certain to buy', 'Likely to buy']);
  });

  test('wrong methodology tag → refuses position, falls back to labels', () => {
    const r = resolveBoxSet({ ...base, question: { methodology: 'ces', type: 'single', options: CSAT_REWORD } });
    expect(r.basis).toBe('label_fallback');
  });

  test('wrong option count → refuses position (a 6-point scale is not the scale)', () => {
    const r = resolveBoxSet({ ...base, question: { methodology: 'csat', type: 'single', options: [...CSAT_REWORD, 'Perfect'] } });
    expect(r.basis).toBe('label_fallback');
  });

  test('wrong type → refuses position', () => {
    const r = resolveBoxSet({ ...base, question: { methodology: 'csat', type: 'multi', options: CSAT_REWORD } });
    expect(r.basis).toBe('label_fallback');
  });

  test('no options metadata at all → label_only, and off-scale is unknowable', () => {
    const r = resolveBoxSet({ ...base, question: { methodology: 'csat', type: 'single' } });
    expect(r.basis).toBe('label_only');
    expect(r.optionSet).toBeNull();
    expect(offScaleCount(['anything'], r.optionSet)).toBeNull();
  });
});

describe('auditZeroBox — loud on a suspicious zero, quiet on a real one', () => {
  const call = (o) => auditZeroBox({ metric: 'm', questionId: 'q', ...o });

  test('positional + every answer on-scale → a real 0%, no flag', () => {
    expect(call({ count: 0, base: 40, basis: 'positional', offScale: 0 })).toBeNull();
  });
  test('positional but answers off-scale → flagged as likely drift', () => {
    const f = call({ count: 0, base: 40, basis: 'positional', offScale: 12 });
    expect(f.reason).toBe('zero_top_box_against_healthy_base');
    expect(f.likely_label_drift).toBe(true);
  });
  test('label fallback → flagged even with no off-scale evidence', () => {
    expect(call({ count: 0, base: 40, basis: 'label_fallback', offScale: 0 })).not.toBeNull();
  });
  test('no options to check against → flagged as unverifiable', () => {
    expect(call({ count: 0, base: 40, basis: 'label_only', offScale: null }).unverifiable).toBe(true);
  });
  test('a non-zero box is never flagged', () => {
    expect(call({ count: 1, base: 40, basis: 'label_only', offScale: 40 })).toBeNull();
  });
  test('a small base is allowed to be zero', () => {
    expect(call({ count: 0, base: 4, basis: 'label_only', offScale: 4 })).toBeNull();
  });
});

describe('reworded options no longer produce a silent 0%', () => {
  test('satisfaction CSAT: identical top-2 under canonical and reworded labels', () => {
    const idx = [4, 3, 2, 4, 3]; // 4/5 in the top-2 box
    const score = (opts) => computeSatisfaction(
      rows('q4', topHeavy(opts, idx)),
      [{ id: 'q4', methodology: 'csat', type: 'single', options: opts }], {},
    ).csat;
    const canon = score(CSAT_CANON);
    const reword = score(CSAT_REWORD);
    expect(canon.top2_pct).toBe(80);
    expect(reword.top2_pct).toBe(80);          // was 0 before Pass 51
    expect(reword.scale_basis).toBe('positional');
    expect(reword.off_scale_n).toBe(0);
    expect(reword.zero_box_flag).toBeNull();
  });

  test('validate intent: identical top-2 under canonical and reworded labels', () => {
    const idx = [0, 1, 2, 0, 3]; // 3/5 in the top-2 box
    const score = (opts) => computeValidate(
      rows('q6', topHeavy(opts, idx)),
      [{ id: 'q6', funnel_stage: 'intent', type: 'single', options: opts }], {},
    ).intent;
    expect(score(INTENT_CANON).top2_pct).toBe(60);
    expect(score(INTENT_REWORD).top2_pct).toBe(60); // was 0 before Pass 51
    expect(score(INTENT_REWORD).scale_basis).toBe('positional');
  });

  test('market_entry intent: identical top-2 under canonical and reworded labels', () => {
    const idx = [0, 1, 2, 0, 3];
    const score = (opts) => computeMarketEntry(
      rows('q3', topHeavy(opts, idx)),
      [{ id: 'q3', kind: 'intent', type: 'single', options: opts }],
      { targeted_markets: ['SA'] },
    ).markets[0];
    expect(score(INTENT_CANON).purchase_intent_pct).toBe(60);
    const reword = score(INTENT_REWORD);
    expect(reword.purchase_intent_pct).toBe(60);    // was 0 before Pass 51
    expect(reword.intent_scale_basis).toBe('positional');
    expect(reword.intent_zero_box_flag).toBeNull();
  });

  test('churn win-back: affirmative read positionally, not as the string "yes"', () => {
    const score = (opts) => computeChurn(
      rows('q6', rep([opts[0], opts[1], opts[0], opts[2], opts[1]], N)),
      [{ id: 'q6', churn_stage: 'win_back', type: 'single', options: opts }], {},
    ).winback;
    expect(score(['Yes', 'Maybe', 'No']).winnable_pct).toBe(40);
    const reword = score(['Definitely', 'Perhaps', 'Never']);
    expect(reword.winnable_pct).toBe(40);           // was 0 before Pass 51
    expect(reword.scale_basis).toBe('positional');
  });

  test('marketing aided recall: affirmative read positionally', () => {
    const score = (opts) => computeMarketing(
      rows('q4', rep([opts[0], opts[1], opts[0], opts[2], opts[1]], N)),
      [{ id: 'q4', funnel_stage: 'recall', type: 'single', options: opts }],
      { brand_name: 'Acme' },
    ).funnel.recall_aided;
    expect(score(['Yes', 'No', 'Not sure']).positive_rate).toBe(0.4);
    const reword = score(['Affirmative', 'Negative', 'Unsure']);
    expect(reword.positive_rate).toBe(0.4);         // was 0 before Pass 51
    expect(reword.scale_basis).toBe('positional');
  });
});

describe('answers that drift off the scale fail LOUDLY, not silently', () => {
  // Positional scoring cannot rescue an answer that is not on the scale at
  // all ('Y' against options ["Yes","No","Not sure"]). What it MUST do is
  // refuse to report the resulting 0% as a finding.
  test('marketing: 0% recall with every answer off-scale is flagged', () => {
    const out = computeMarketing(
      rows('q4', rep(['Y', 'N', 'Y', 'Nope', 'N'], N)),
      [{ id: 'q4', funnel_stage: 'recall', type: 'single', options: ['Yes', 'No', 'Not sure'] }],
      { brand_name: 'Acme' },
    ).funnel.recall_aided;
    expect(out.positive_rate).toBe(0);
    expect(out.n).toBe(N);                       // full, healthy-looking base
    expect(out.off_scale_n).toBe(N);             // ...every one of them off-scale
    expect(out.zero_box_flag).not.toBeNull();
    expect(out.zero_box_flag.likely_label_drift).toBe(true);
  });

  test('brand_lift: 0% yes-rate against a healthy base is flagged both cells', () => {
    const rws = [];
    rep(['Y', 'Y', 'N', 'Y', 'N'], N).forEach((a, i) => rws.push({ persona_id: `e${i}`, question_id: 'q2', answer: a, exposure_status: 'exposed' }));
    rep(['Y', 'N', 'N', 'Y', 'N'], N).forEach((a, i) => rws.push({ persona_id: `c${i}`, question_id: 'q2', answer: a, exposure_status: 'control' }));
    const f = computeBrandLift(rws, [
      { id: 'q1', funnel_stage: 'screening', is_lift_question: false, type: 'single', options: ['Yes', 'No'] },
      { id: 'q2', text: 'Consideration', funnel_stage: 'brand_consideration', is_lift_question: true, type: 'single', options: ['Yes', 'No'] },
    ], { brand_name: 'Acme' }).funnel.find((x) => x.question_id === 'q2');

    expect(f.exposed).toEqual({ n: N, positive: 0, rate: 0 });
    expect(f.control).toEqual({ n: N, positive: 0, rate: 0 });
    expect(f.off_scale_n).toBe(2 * N);
    expect(f.zero_box_flags).toHaveLength(2);
    expect(f.zero_box_flags[0].likely_label_drift).toBe(true);
    // brand_lift deliberately keeps LABEL resolution: the generator contract
    // never pins option text or order for its affirmative singles, so there is
    // no canonical position to read. Drift is detected, not silently rescored.
    expect(f.scale_basis).toBe('label');
  });

  test('a genuine 0% on a fully on-scale positional question is NOT flagged', () => {
    const opts = CSAT_CANON;
    const out = computeSatisfaction(
      rows('q4', rep([opts[0], opts[1], opts[2]], N)), // nobody is satisfied — real finding
      [{ id: 'q4', methodology: 'csat', type: 'single', options: opts }], {},
    ).csat;
    expect(out.top2_pct).toBe(0);
    expect(out.off_scale_n).toBe(0);
    expect(out.zero_box_flag).toBeNull();
  });
});

describe('canonical production data is unaffected (latent, not live)', () => {
  test('every module returns its pre-Pass-51 number on canonical labels', () => {
    const idx = [4, 3, 2, 4, 3];
    expect(computeSatisfaction(rows('q4', topHeavy(CSAT_CANON, idx)),
      [{ id: 'q4', methodology: 'csat', type: 'single', options: CSAT_CANON }], {}).csat.top2_pct).toBe(80);
    expect(computeValidate(rows('q6', topHeavy(INTENT_CANON, [0, 1, 2, 0, 3])),
      [{ id: 'q6', funnel_stage: 'intent', type: 'single', options: INTENT_CANON }], {}).intent.top2_pct).toBe(60);
    expect(computeChurn(rows('q6', rep(['Yes', 'Maybe', 'Yes', 'No', 'Maybe'], N)),
      [{ id: 'q6', churn_stage: 'win_back', type: 'single', options: ['Yes', 'Maybe', 'No'] }], {}).winback.winnable_pct).toBe(40);
  });
});
