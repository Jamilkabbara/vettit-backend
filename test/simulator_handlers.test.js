/**
 * Pass 47 — simulator unit tests for the new behaviors:
 *  - max_diff_set answers persist as {best, worst} (roadmap consumes this)
 *  - rating answers pass through unchanged on non-5-point scales (NPS 0-10)
 *  - token budget scales with question count (truncation fix)
 *  - missing/truncated tail questions are recovered by the retry pass
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Mock only callClaude; keep the real extractJSON. requireActual must
// happen INSIDE the factory (jest forbids out-of-scope refs in the
// hoisted mock factory).
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(),
  extractJSON: jest.requireActual('../src/services/ai/anthropic').extractJSON,
}));

const { callClaude: mockCallClaude } = require('../src/services/ai/anthropic');
const { simulateResponses, tokenBudgetFor } = require('../src/services/ai/simulate');

const persona = { id: 'p1', name: 'Test Persona', age: 30 };
const mission = { id: 'm1', user_id: 'u1', goal_type: 'roadmap', brief: 'test brief' };

beforeEach(() => { jest.clearAllMocks(); });

test('tokenBudgetFor scales with question count (floor 1500, cap 8000)', () => {
  expect(tokenBudgetFor(0)).toBe(1500);
  expect(tokenBudgetFor(5)).toBe(1500);      // 5*220=1100 → floored
  expect(tokenBudgetFor(13)).toBe(2860);     // 13*220
  expect(tokenBudgetFor(23)).toBe(5060);     // 23*220
  expect(tokenBudgetFor(100)).toBe(8000);    // capped
});

test('max_diff_set answer persists as a {best, worst} object', async () => {
  const questions = [
    { id: 'q1', type: 'max_diff_set', text: 'best/worst', options: ['A', 'B', 'C', 'D'] },
  ];
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({ responses: [
      { question_id: 'q1', answer: { best: 'A', worst: 'D' }, reasoning: 'x' },
    ] }),
  });
  const out = await simulateResponses(persona, questions, mission);
  expect(out).toHaveLength(1);
  expect(out[0].question_id).toBe('q1');
  expect(out[0].answer).toEqual({ best: 'A', worst: 'D' });
});

test('rating on a 0-10 scale passes the number through unchanged (no 1-5 clamp)', async () => {
  const questions = [
    { id: 'q1', type: 'rating', text: 'NPS 0-10', options: ['0','1','2','3','4','5','6','7','8','9','10'] },
  ];
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({ responses: [{ question_id: 'q1', answer: 9, reasoning: 'x' }] }),
  });
  const out = await simulateResponses(persona, questions, mission);
  expect(out[0].answer).toBe(9);
  // token budget reflects the question count
  const callArgs = mockCallClaude.mock.calls[0][0];
  expect(callArgs.maxTokens).toBe(tokenBudgetFor(1));
});

test('missing tail questions are recovered by the retry pass', async () => {
  const questions = [
    { id: 'q1', type: 'single', text: 'a', options: ['x', 'y'] },
    { id: 'q2', type: 'single', text: 'b', options: ['x', 'y'] },
    { id: 'q3', type: 'single', text: 'c (truncated tail)', options: ['x', 'y'] },
  ];
  // First call: truncated — only q1, q2 returned.
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({ responses: [
      { question_id: 'q1', answer: 'x', reasoning: 'r' },
      { question_id: 'q2', answer: 'y', reasoning: 'r' },
    ] }),
  });
  // Retry: the missing q3.
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({ responses: [
      { question_id: 'q3', answer: 'x', reasoning: 'r' },
    ] }),
  });
  const out = await simulateResponses(persona, questions, mission);
  expect(mockCallClaude).toHaveBeenCalledTimes(2);
  expect(out.map((r) => r.question_id)).toEqual(['q1', 'q2', 'q3']); // ordered + complete
  // The retry re-asked ONLY the missing question.
  const retryPrompt = mockCallClaude.mock.calls[1][0].messages[0].content;
  expect(retryPrompt).toContain('[q3]');
  expect(retryPrompt).not.toContain('[q1]');
});

test('a fully-answered survey makes no retry call', async () => {
  const questions = [{ id: 'q1', type: 'single', text: 'a', options: ['x', 'y'] }];
  mockCallClaude.mockResolvedValueOnce({
    text: JSON.stringify({ responses: [{ question_id: 'q1', answer: 'x', reasoning: 'r' }] }),
  });
  await simulateResponses(persona, questions, mission);
  expect(mockCallClaude).toHaveBeenCalledTimes(1);
});

test('zero parseable responses returns empty (loop guard then rejects the persona)', async () => {
  const questions = [{ id: 'q1', type: 'single', text: 'a', options: ['x', 'y'] }];
  mockCallClaude.mockResolvedValue({ text: 'not json at all' });
  const out = await simulateResponses(persona, questions, mission);
  expect(out).toEqual([]);
});
