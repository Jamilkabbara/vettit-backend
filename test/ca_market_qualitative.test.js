/**
 * Market is qualitative only: it must not change any number.
 *
 * Owner's rule for Creative Attention targeting: "Market is qualitative only.
 * A test must fail if market changes any number."
 *
 * HOW THIS TEST CAN SEE A LEAK
 * ----------------------------
 * Asserting that a prompt string lacks the word "Saudi" proves one wording is
 * absent. It does not prove the market cannot move a score. So the model is
 * replaced by a stub that is deliberately corrupt: whenever a market name or
 * code appears in the text it is asked to score, it returns DIFFERENT numbers.
 * The real analyzeCreative is then run end to end for the same creative with
 * no market, Saudi Arabia, the UAE, Egypt and an unknown code. If market
 * reaches any step that produces a number - a frame score, the attention
 * prediction, a platform fit, the composite, the placement benchmark - some
 * number in the saved analysis differs between runs and this fails.
 *
 * The positive control proves the stub is genuinely sensitive: put a market
 * name in the BRIEF (which the scoring steps are meant to read) and the
 * numbers do change. Without that control a stub that ignored its input would
 * make every assertion below pass vacuously.
 */

// ── Module mocks (hoisted) ──────────────────────────────────────────────────
jest.mock('../src/db/supabase', () => ({ from: jest.fn(), storage: { from: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/ai/insights', () => ({ sanitizeAIOutputDeep: (x) => x }));

const mockCa = { framePrompts: [], synthPrompts: [], marketPrompts: [], leaks: [] };
const mockMarketWords = /Saudi|Emirates|Egypt|\bSA\b|\bAE\b|\bEG\b|NOT_A_MARKET/;

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: {
    create: jest.fn(async ({ messages }) => {
      const text = messages[0].content.find((c) => c.type === 'text').text;
      mockCa.framePrompts.push(text);
      const k = mockMarketWords.test(text) ? 1 : 0;
      if (k) mockCa.leaks.push('frame');
      return {
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ text: JSON.stringify({
          timestamp: 0,
          emotions: { joy: 40 + 7 * k, trust: 30 + 3 * k, curiosity: 55 - 5 * k },
          attention_hotspots: [{ label: 'logo', x: 0.1 + 0.05 * k, y: 0.2, w: 0.3, h: 0.3, weight: 70 + 5 * k }],
          message_clarity: 55 + 9 * k,
          audience_resonance: 50 + 11 * k,
          engagement_score: 60 + 17 * k,
          brief_description: 'A bottle on a table.',
        }) }],
      };
    }),
  },
})));

jest.mock('../src/services/ai/anthropic', () => ({
  extractJSON: (t) => JSON.parse(t),
  recordMissionAiSpend: jest.fn(),
  callClaude: jest.fn(async ({ callType, messages }) => {
    const text = messages[0].content;
    if (callType === 'creative_attention_market_context') {
      mockCa.marketPrompts.push(text);
      return { text: JSON.stringify({
        cultural_fit: ['The warm domestic setting reads as family-oriented, which suits the market.'],
        localisation_risks: ['Arabic copy is expected on the pack shot.', 'Engagement runs 30% higher in this market.'],
        placement_notes: ['Short vertical video is the default consumption mode here.'],
      }) };
    }
    mockCa.synthPrompts.push(text);
    const k = mockMarketWords.test(text) ? 1 : 0;
    if (k) mockCa.leaks.push('synthesis');
    return { text: JSON.stringify({
      overall_engagement_score: 62 + 8 * k,
      emotion_peaks: [{ emotion: 'joy', peak_timestamp: 0, peak_value: 40 + 6 * k, interpretation: 'Warmth.' }],
      attention_arc: 'Holds early.',
      strengths: ['Clear product shot.'],
      weaknesses: ['Logo is small.'],
      recommendations: ['Enlarge the logo.'],
      vs_benchmark: 'Above the TikTok Feed norm.',
      best_platform_fit: [{ platform: 'TikTok Feed', rationale: 'Vertical.', platform_norm_active_attention_seconds: 1.4, predicted_creative_attention_seconds: 1.6 + 0.4 * k, delta_vs_norm_pct: 14 + 29 * k, fit_score: 80 + 6 * k }],
      attention: {
        predicted_active_attention_seconds: 1.6 + 0.7 * k,
        predicted_passive_attention_seconds: 0.9,
        active_attention_pct: 55 + 5 * k, passive_attention_pct: 30 - 5 * k, non_attention_pct: 15,
        distinctive_brand_asset_score: 40 + 12 * k, dba_read_seconds: 1.2,
        attention_decay_curve: [{ second: 0, active_pct: 55 + 5 * k }],
      },
      channel_benchmarks: [{ channel: 'Social Feed (paid)', fit_assessment: 'Fits.', predicted_for_this_creative: 1.6 + 0.3 * k, category_avg_attention_seconds: 1.2 }],
      creative_effectiveness: {
        components: { attention: 60 + 10 * k, emotion_intensity: 55, brand_clarity: 50 + 4 * k, audience_resonance: 52, platform_fit: 78 },
        band_explanation: 'Attention leads.',
      },
    }) };
  }),
}));

const { runAnalysis, numericLeaves } = require('./helpers/caRunner');

const MISSION = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000a',
  user_id: '11111111-1111-4111-8111-111111111111',
  goal_type: 'creative_attention',
  media_type: 'image',
  brand_name: 'Orchard',
  ca_target_audience: 'Working parents buying for the family',
  brief: 'Launch post for a new juice.',
  desired_emotions: ['Trust', 'Joy'],
  key_message: 'Try it this week',
  ca_placement: 'instagram_feed',
  brief_attachment: { path: 'u/creative-attention/x.jpg', mimeType: 'image/jpeg' },
};

describe('market cannot change any number in a Creative Attention analysis', () => {
  const runs = {};

  beforeAll(async () => {
    for (const market of [null, 'SA', 'AE', 'EG', 'NOT_A_MARKET']) {
      mockCa.leaks = [];
      const r = await runAnalysis(mockCa, { ...MISSION, ca_market: market });
      runs[market || 'none'] = { ...r, leaks: [...mockCa.leaks] };
    }
  });

  test('every run produced a saved analysis', () => {
    for (const r of Object.values(runs)) expect(r.analysis).toBeTruthy();
  });

  test('POSITIVE CONTROL: the stub changes its numbers when it can see a market name', async () => {
    mockCa.leaks = [];
    const leaky = await runAnalysis(mockCa, { ...MISSION, ca_market: null, brief: 'Launch post for a new juice in Saudi Arabia.' });
    expect(mockCa.leaks.length).toBeGreaterThan(0);
    expect(numericLeaves(leaky.analysis)).not.toEqual(numericLeaves(runs.none.analysis));
  });

  test('no number-producing step ever saw the market', () => {
    for (const [name, r] of Object.entries(runs)) {
      expect({ run: name, leaks: r.leaks }).toEqual({ run: name, leaks: [] });
    }
  });

  test('every number in the saved analysis is identical with and without a market', () => {
    const baseline = numericLeaves(runs.none.analysis);
    expect(Object.keys(baseline).length).toBeGreaterThan(20); // the comparison has teeth
    for (const name of ['SA', 'AE', 'EG', 'NOT_A_MARKET']) {
      expect({ run: name, numbers: numericLeaves(runs[name].analysis) }).toEqual({ run: name, numbers: baseline });
    }
  });

  test('the placement benchmark is present and the same for every market', () => {
    const pb = runs.none.analysis.placement_benchmark;
    expect(pb).toEqual({
      placement_id: 'instagram_feed', placement_label: 'Instagram Feed',
      norm_active_seconds: 1.2, predicted_active_seconds: 1.6, delta_vs_norm_pct: 33,
    });
    for (const name of ['SA', 'AE', 'EG']) expect(runs[name].analysis.placement_benchmark).toEqual(pb);
  });

  test('the frame and synthesis prompts are byte-identical across markets', () => {
    for (const name of ['SA', 'AE', 'EG', 'NOT_A_MARKET']) {
      expect(runs[name].framePrompts).toEqual(runs.none.framePrompts);
      expect(runs[name].synthPrompts).toEqual(runs.none.synthPrompts);
    }
  });

  test('the market is recorded and adds only text', () => {
    expect(runs.SA.analysis.market).toEqual({ code: 'SA', name: 'Saudi Arabia' });
    expect(runs.AE.analysis.market).toEqual({ code: 'AE', name: 'United Arab Emirates' });
    for (const name of ['SA', 'AE', 'EG']) {
      const ctx = runs[name].analysis.market_context;
      expect(ctx).toBeTruthy();
      expect(JSON.stringify(ctx)).not.toMatch(/\d/);
      expect(runs[name].marketPrompts).toHaveLength(1);
    }
    // the stub's invented statistic was dropped, the plain sentence kept
    expect(runs.SA.analysis.market_context.localisation_risks).toEqual(['Arabic copy is expected on the pack shot.']);
  });

  test('no market, or a code that is not a market, adds nothing and makes no market call', () => {
    for (const name of ['none', 'NOT_A_MARKET']) {
      expect(runs[name].analysis.market).toBeUndefined();
      expect(runs[name].analysis.market_context).toBeUndefined();
      expect(runs[name].marketPrompts).toHaveLength(0);
    }
  });
});
