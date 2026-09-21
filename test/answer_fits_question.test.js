/**
 * An answer has to be an answer to THAT question.
 *
 * Mission bae6613a, 2026-09-21: one respondent of five answered q2 (a
 * five-option "biggest challenges" battery) with q4's delivery-format options,
 * and answered q3 - a five-point opinion scale - with an ARRAY of q2's
 * options. It parsed cleanly, it stored cleanly, and it would have been a bar
 * in the customer's chart.
 *
 * It is not new and it is not rare. Across delivered studies, 468 of 6,243
 * stored choice answers (7.5%, 11 studies, 140 respondents) are values that
 * were never on offer for the question they are filed under. The worst is 19%
 * of a 300-respondent study, in August.
 *
 * Questions are presented in a per-persona order and multi-select options now
 * rotate, so a model that answers by position rather than by id produces
 * exactly this. Nothing compared an answer with the option list it came from.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockCalls = [];
const mockState = { behaviour: 'correct' };
jest.mock('../src/services/ai/anthropic', () => ({
  MODEL_ROUTING: {},
  MODEL_PRICING: {},
  extractJSON: (t) => JSON.parse(t),
  callClaude: jest.fn(async ({ messages }) => {
    const prompt = messages[0].content;
    const asked = [...prompt.matchAll(/^\d+\. \[([^\]]+)\][^\n]*(?:\n\s+options: (\[[^\n]*\]))?/gm)]
      .map((m) => ({ qid: m[1], options: m[2] ? JSON.parse(m[2]) : null }));
    mockCalls.push(asked.map((a) => a.qid));

    const answerFor = ({ qid, options }, index) => {
      if (!options) return { question_id: qid, answer: 'some free text', reasoning: 'r' };
      // "shifted": answer every question with the NEXT question's options, which
      // is what answering by position looks like.
      const shift = mockState.behaviour === 'shifted' && mockCalls.length === 1;
      const src = shift ? (asked[(index + 1) % asked.length].options || options) : options;
      return { question_id: qid, answer: [src[0]], reasoning: 'r' };
    };
    return { text: JSON.stringify({ responses: asked.map(answerFor) }) };
  }),
}));

const { simulateResponses, answerFitsQuestion } = require('../src/services/ai/simulate');

const QUESTIONS = [
  { id: 'q1', type: 'multi', text: 'biggest challenges', options: ['Internal expertise', 'How AI works', 'Pace of change', 'Measuring ROI', 'None of these'] },
  { id: 'q2', type: 'multi', text: 'delivery format', options: ['On-demand modules', 'Live workshops', 'In-person bootcamps', 'Coaching', 'None of these'] },
  { id: 'q3', type: 'opinion', text: 'our programmes are adequate', options: ['Strongly Agree', 'Agree', 'Neutral', 'Disagree', 'Strongly Disagree'] },
];

const MISSION = { id: 'm-fit', user_id: 'u', goal_type: 'research', brief: 'b', questions: QUESTIONS };
const PERSONA = { id: 'P009', persona_id: 'P009', first_name: 'Test', age: 40, city: 'Dubai', occupation: 'Manager' };

beforeEach(() => { mockCalls.length = 0; mockState.behaviour = 'correct'; jest.clearAllMocks(); });

describe('the rule itself', () => {
  test('an answer from another question is not an answer to this one', () => {
    expect(answerFitsQuestion(QUESTIONS[0], ['Internal expertise'])).toBe(true);
    expect(answerFitsQuestion(QUESTIONS[0], ['Live workshops'])).toBe(false);      // q2's option
    expect(answerFitsQuestion(QUESTIONS[2], ['Internal expertise'])).toBe(false);  // q1's, and an array
    expect(answerFitsQuestion(QUESTIONS[2], 'Disagree')).toBe(true);
  });

  test('one stray value spoils a multi-select answer: it means a different question was answered', () => {
    expect(answerFitsQuestion(QUESTIONS[0], ['Internal expertise', 'Live workshops'])).toBe(false);
  });

  test('case and padding do not matter; empty does', () => {
    expect(answerFitsQuestion(QUESTIONS[2], '  disagree ')).toBe(true);
    expect(answerFitsQuestion(QUESTIONS[0], [])).toBe(false);
  });

  test('free text and ratings are not judged against an option list', () => {
    expect(answerFitsQuestion({ id: 'q', type: 'text', options: [] }, 'anything at all')).toBe(true);
    expect(answerFitsQuestion({ id: 'q', type: 'rating', options: ['1', '2', '3', '4', '5'] }, 4)).toBe(true);
  });

  test('max_diff needs both picks to be on offer', () => {
    const q = { id: 'md', type: 'max_diff_set', options: ['A', 'B', 'C'] };
    expect(answerFitsQuestion(q, { best: 'A', worst: 'C' })).toBe(true);
    expect(answerFitsQuestion(q, { best: 'A', worst: 'Z' })).toBe(false);
  });
});

describe('through the simulator', () => {
  test('a clean model is untouched: every question answered, once', async () => {
    const rows = await simulateResponses(PERSONA, QUESTIONS, MISSION);
    expect(rows.map((r) => r.question_id)).toEqual(['q1', 'q2', 'q3']);
    expect(mockCalls).toHaveLength(1);                       // no retry needed
  });

  test('THE BUG: answers shifted onto the wrong questions are re-asked, not stored', async () => {
    mockState.behaviour = 'shifted';

    const rows = await simulateResponses(PERSONA, QUESTIONS, MISSION);

    // A second call happened: the misfiled questions were re-asked.
    expect(mockCalls.length).toBeGreaterThan(1);
    // And nothing stored is an answer from another question's option list.
    const byId = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
    for (const r of rows) expect(answerFitsQuestion(byId[r.question_id], r.answer)).toBe(true);
    expect(rows.length).toBe(QUESTIONS.length);
  });
});
