/**
 * Every vision call VETT had ever made was missing from the mission's spend.
 *
 * creativeAttention.js cannot use callClaude — vision needs raw image blocks —
 * so it talks to the SDK directly and writes its own ai_calls row. The rollup
 * onto missions.ai_spend_usd_actual lived INSIDE callClaude, so the frame calls
 * logged their cost to the audit table and then vanished from the mission
 * total. That total is what the margin dashboards read and what the recruit
 * loop compares its ceiling against.
 *
 * Measured in production before the fix:
 *
 *   cff8a2ec  video, 30 frames + 1 synthesis   recorded $0.0694   real $0.4759
 *   3348d47b  image,  1 frame  + 1 synthesis   recorded $0.0030   real $0.0611
 *
 * The recorded figure is in every case exactly the calls that DID go through
 * callClaude, which is the signature of the bug.
 */
const { recordMissionAiSpend } = require('../src/services/ai/anthropic');
const supabase = require('../src/db/supabase');

jest.mock('../src/db/supabase', () => ({ rpc: jest.fn(), from: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  supabase.rpc.mockReturnValue({ then: (cb) => { cb({ error: null }); return { catch: () => {} }; } });
});

describe('recordMissionAiSpend', () => {
  test('rolls a cost up through the atomic RPC', () => {
    recordMissionAiSpend('m1', 0.4065);
    expect(supabase.rpc).toHaveBeenCalledWith('increment_mission_ai_spend', {
      p_mission_id: 'm1', p_cost: 0.4065,
    });
  });

  test.each([
    ['no mission id', null],
    ['undefined mission id', undefined],
    ['empty mission id', ''],
  ])('%s writes nothing', (_label, missionId) => {
    recordMissionAiSpend(missionId, 0.5);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['zero', 0], ['negative', -1], ['NaN', NaN], ['not a number', 'free'],
  ])('a %s cost writes nothing', (_label, cost) => {
    recordMissionAiSpend('m1', cost);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('the 30 frame calls of a video mission roll up to its real spend', () => {
    // The per-frame costs from cff8a2ec, summed the way 30 separate calls do.
    const perFrame = 0.4065 / 30;
    for (let i = 0; i < 30; i += 1) recordMissionAiSpend('cff8a2ec', perFrame);
    expect(supabase.rpc).toHaveBeenCalledTimes(30);
    const total = supabase.rpc.mock.calls.reduce((a, c) => a + c[1].p_cost, 0);
    expect(total).toBeCloseTo(0.4065, 4);
  });
});

describe('the creative-attention frame writer calls it', () => {
  test('creativeAttention.js imports and invokes recordMissionAiSpend', () => {
    // Source-level, because the frame writer talks to the SDK directly and
    // faking that costs more than it proves. What must never regress is that
    // this file rolls its own cost up rather than only logging a row.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'ai', 'creativeAttention.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/anthropic'\)/);
    expect(src).toMatch(/recordMissionAiSpend/);
    // It must fire for the FRAME call, i.e. right after the frame ai_calls
    // insert, not only for the synthesis call that already went through
    // callClaude.
    const afterFrameInsert = src.slice(src.indexOf("call_type:    'creative_attention_frame'"));
    expect(afterFrameInsert).toMatch(/recordMissionAiSpend\(mission\.id, costUsd\)/);
  });
});
