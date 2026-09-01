/**
 * Pass 46 Phase 2 — empty-survey guard unit tests (audit P0-5).
 */

jest.mock('../src/services/claudeAI', () => ({
  generateSurvey: jest.fn(),
}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  // Pass 49 — heartbeat_at availability latch (migration applied by hand).
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const ai = require('../src/services/claudeAI');
const { updateMission } = require('../src/db/missionSchema');
const { ensureMissionQuestions } = require('../src/services/ai/ensureQuestions');

const GOOD_QS = [
  { id: 'q1', text: 'How often do you order?', type: 'single', options: ['Daily', 'Weekly'] },
  { id: 'q2', text: 'Rate your satisfaction.', type: 'rating', options: [] },
];

const supabase = {}; // updateMission is mocked; the client is passed through

beforeEach(() => jest.clearAllMocks());

test('returns existing questions without touching the generator', async () => {
  const qs = await ensureMissionQuestions(supabase, {
    id: 'm1', questions: GOOD_QS, brief: 'irrelevant here, already has questions',
  });
  expect(qs).toBe(GOOD_QS);
  expect(ai.generateSurvey).not.toHaveBeenCalled();
  expect(updateMission).not.toHaveBeenCalled();
});

test('generates + persists when questions are empty', async () => {
  ai.generateSurvey.mockResolvedValue({ questions: GOOD_QS, missionStatement: '', productName: '' });
  const qs = await ensureMissionQuestions(supabase, {
    id: 'm2', questions: [], goal_type: 'research',
    brief: 'Understand how UAE residents choose between food delivery apps.',
  });
  expect(qs).toEqual(GOOD_QS);
  expect(ai.generateSurvey).toHaveBeenCalledTimes(1);
  expect(ai.generateSurvey.mock.calls[0][0].goal).toBe('research');
  expect(updateMission).toHaveBeenCalledTimes(1);
  expect(updateMission.mock.calls[0][2]).toEqual({ questions: GOOD_QS });
});

test('throws when the generator returns no questions (mission must fail, never run empty)', async () => {
  ai.generateSurvey.mockResolvedValue({ questions: [], missionStatement: '', productName: '' });
  await expect(ensureMissionQuestions(supabase, {
    id: 'm3', questions: null, goal_type: 'research',
    brief: 'A perfectly long and reasonable brief about something researchable.',
  })).rejects.toThrow(/no questions/);
  expect(updateMission).not.toHaveBeenCalled();
});

test('throws on unusable brief without calling the generator', async () => {
  await expect(ensureMissionQuestions(supabase, {
    id: 'm4', questions: [], goal_type: 'research', brief: 'too short',
  })).rejects.toThrow(/no usable brief/);
  expect(ai.generateSurvey).not.toHaveBeenCalled();
});
