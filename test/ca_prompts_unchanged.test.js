/**
 * Creative Attention missions without a placement get exactly the prompts
 * they got before placement and market existed.
 *
 * test/fixtures/ca_prompts_before.json was recorded from unmodified main
 * (2968bd2) by running analyzeCreative with the model mocked. This runs the
 * current code over the same missions with the SAME stubs and compares every
 * prompt byte for byte.
 *
 * One difference is intended and asserted exactly: a mission whose shared
 * target_audience column holds an object used to send
 * "Target audience: [object Object]" and now sends
 * "Target audience: not specified". Nothing else in that prompt may move.
 *
 * A chosen placement is allowed to add exactly two things to the synthesis
 * prompt - the placement line and its vs_benchmark rule - and nothing to the
 * frame prompt.
 */
jest.mock('../src/db/supabase', () => ({ from: jest.fn(), storage: { from: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/ai/insights', () => ({ sanitizeAIOutputDeep: (x) => x }));
const mockCa = { framePrompts: [], synthPrompts: [], marketPrompts: [] };
// Stubs identical to the ones the fixture was recorded with.
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(async ({ callType, messages }) => {
    if (callType === 'creative_attention_market_context') { mockCa.marketPrompts.push(messages[0].content); return { text: '{}' }; }
    mockCa.synthPrompts.push(messages[0].content);
    return { text: '{}' };
  }),
  extractJSON: (t) => JSON.parse(t),
  recordMissionAiSpend: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn(async ({ messages }) => {
    mockCa.framePrompts.push(messages[0].content.find((c) => c.type === 'text').text);
    return { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ text: JSON.stringify({ timestamp: 0, emotions: {}, attention_hotspots: [], message_clarity: 50, audience_resonance: 50, engagement_score: 50, brief_description: 'x' }) }] };
  }) },
})));
jest.mock('@ffmpeg-installer/ffmpeg', () => ({ path: '/nonexistent/ffmpeg' }));
jest.mock('fluent-ffmpeg', () => {
  const fs = require('fs'); const path = require('path');
  const f = jest.fn(() => { const h = {}; let out = null; const api = {
    outputOptions: () => api, output: (p) => { out = p; return api; }, on: (e, cb) => { h[e] = cb; return api; },
    run: () => { for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(path.dirname(out), `frame-${String(i).padStart(4, '0')}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0])); h.end(); } };
    return api; });
  f.setFfmpegPath = () => {}; return f;
});

const before = require('./fixtures/ca_prompts_before.json').missions;
const { CA_PROMPT_FIXTURE_MISSIONS } = require('./helpers/caPromptFixtures');
const { runAnalysis } = require('./helpers/caRunner');

const OBJECT_LINE_BEFORE = 'Target audience: [object Object]';
const OBJECT_LINE_AFTER = 'Target audience: not specified';

describe('prompts for missions without a placement are unchanged', () => {
  const now = {};
  beforeAll(async () => {
    for (const [name, mission] of Object.entries(CA_PROMPT_FIXTURE_MISSIONS)) {
      now[name] = await runAnalysis(mockCa, mission);
    }
  });

  test('the fixture really recorded the defect being fixed', () => {
    expect(before.image_object_audience_draft_shape.frame_prompts[0]).toContain(OBJECT_LINE_BEFORE);
    expect(before.image_object_audience_draft_shape.synthesis_prompts[0]).toContain(OBJECT_LINE_BEFORE);
  });

  for (const name of ['image_string_audience', 'video_string_audience', 'image_no_audience']) {
    test(`${name}: frame and synthesis prompts are byte-identical`, () => {
      expect(now[name].framePrompts).toEqual(before[name].frame_prompts);
      expect(now[name].synthPrompts).toEqual(before[name].synthesis_prompts);
    });
  }

  test('object-form audience: only the audience line changed, to "not specified"', () => {
    const fix = (p) => p.split(OBJECT_LINE_BEFORE).join(OBJECT_LINE_AFTER);
    const b = before.image_object_audience_draft_shape;
    const n = now.image_object_audience_draft_shape;
    expect(n.framePrompts).toEqual(b.frame_prompts.map(fix));
    expect(n.synthPrompts).toEqual(b.synthesis_prompts.map(fix));
    for (const p of [...n.framePrompts, ...n.synthPrompts]) expect(p).not.toContain('[object Object]');
  });

  test('a legacy string audience in target_audience is still honoured', () => {
    expect(now.image_string_audience.framePrompts[0]).toContain('Target audience: Mothers in Saudi');
  });

  test('ca_target_audience wins over the legacy column when both are present', async () => {
    const r = await runAnalysis(mockCa, { ...CA_PROMPT_FIXTURE_MISSIONS.image_string_audience, ca_target_audience: 'New audience text' });
    expect(r.framePrompts[0]).toContain('Target audience: New audience text');
    expect(r.framePrompts[0]).not.toContain('Mothers in Saudi');
  });
});

describe('a chosen placement adds exactly its own lines', () => {
  test('synthesis gains the placement line and rule; the frame prompt is untouched', async () => {
    const base = CA_PROMPT_FIXTURE_MISSIONS.video_string_audience;
    const r = await runAnalysis(mockCa, { ...base, ca_placement: 'tiktok_feed' });
    expect(r.framePrompts).toEqual(before.video_string_audience.frame_prompts);

    const was = before.video_string_audience.synthesis_prompts[0].split('\n');
    const is = r.synthPrompts[0].split('\n');
    const added = is.filter((l) => !was.includes(l));
    const removed = was.filter((l) => !is.includes(l));
    expect(removed).toEqual([]);
    expect(added).toEqual([
      'Chosen placement: TikTok Feed (published norm 1.4s active attention)',
      '- The customer is running this creative on TikTok Feed. Predict attention for how it will run THERE, and write vs_benchmark against the TikTok Feed norm (1.4s) first.',
    ]);
  });

  test('a placement that cannot be scored for the upload (TV on an image) adds nothing', async () => {
    const base = CA_PROMPT_FIXTURE_MISSIONS.image_string_audience;
    const r = await runAnalysis(mockCa, { ...base, ca_placement: 'tv_30s' });
    expect(r.synthPrompts).toEqual(before.image_string_audience.synthesis_prompts);
    expect(r.analysis.placement_benchmark).toBeUndefined();
  });

  test('an unknown placement id adds nothing', async () => {
    const base = CA_PROMPT_FIXTURE_MISSIONS.image_string_audience;
    const r = await runAnalysis(mockCa, { ...base, ca_placement: 'shahid' });
    expect(r.synthPrompts).toEqual(before.image_string_audience.synthesis_prompts);
    expect(r.analysis.placement_benchmark).toBeUndefined();
  });
});
