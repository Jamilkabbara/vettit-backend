/**
 * Every AI call must carry the attribution evidence that exists at its call site.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ai_calls is the record of truth for AI spend. Measured on 2026-11-10:
 * 1,931 of 4,902 rows ($15.26 of $36.15) have mission_id IS NULL, and four
 * call types are 100% unattributed AND carry no user_id either:
 *
 *   survey_gen        139/139 rows, $3.54   user_id NULL on every row
 *   targeting_suggest  64/64  rows, $0.72   user_id NULL on every row
 *   subject_extract    66/66  rows, $0.01   user_id NULL on every row
 *   question_refine     8/8   rows, $0.004  user_id NULL on every row
 *
 * These run before a mission row exists, so mission_id genuinely cannot be
 * set. But user_id CAN: every one of these is reached through a route that
 * already has req.user?.id in scope (src/routes/ai.js even logs it on the
 * line after the call). Dropping it throws away the only evidence that could
 * ever tie the spend to a customer — which is why the historical backfill
 * can recover nothing for them.
 *
 * ensureMissionQuestions is the one genuine "the mission existed and the id
 * was not passed" case: it runs INSIDE runMission, holds the full mission
 * row, and calls generateSurvey with no attribution at all.
 *
 * These tests assert the evidence reaches callClaude. They do NOT assert a
 * false attribution: nothing here invents a mission_id for a pre-mission call.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

let mockAuthUser = { id: 'user-42' };
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    if (!mockAuthUser) return res.status(401).json({ error: 'unauthenticated' });
    req.user = mockAuthUser;
    next();
  },
  optionalAuthenticate: (req, _res, next) => {
    if (mockAuthUser) req.user = mockAuthUser;
    next();
  },
}));

jest.mock('../src/db/supabase', () => ({
  from() {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: () => chain,
      then: (resolve) => resolve({ data: null, error: null }),
    };
    return chain;
  },
  rpc: async () => ({ error: null }),
}));

// Controlled model output; every call's args are recorded for assertion.
const mockClaudeCalls = [];
const mockSurveyJson = JSON.stringify({
  productName: 'Test Product',
  missionStatement: 'To test attribution.',
  questions: [
    { id: 'q1', text: 'Do you buy this category?', type: 'single', options: ['Yes', 'No'], isScreening: true },
    { id: 'q2', text: 'How often do you buy it?', type: 'single', options: ['Weekly', 'Monthly', 'Rarely'], isScreening: false },
  ],
  targetingSuggestions: { recommendedCountries: ['US'], recommendedAgeRanges: ['25-44'], recommendedGenders: [], reasoning: 'test' },
  suggestedRespondentCount: 200,
});

jest.mock('../src/services/ai/anthropic', () => {
  const actual = jest.requireActual('../src/services/ai/anthropic');
  return {
    ...actual,
    callClaude: jest.fn(async (args) => {
      mockClaudeCalls.push(args);
      if (args.callType === 'subject_extract') return { text: 'Test Product', costUsd: 0 };
      if (args.callType === 'targeting_suggest') {
        return { text: JSON.stringify({ recommendedCountries: ['US'], reasoning: 'test' }), costUsd: 0 };
      }
      if (args.callType === 'question_refine') {
        return { text: JSON.stringify({ refinedText: 'Improved question?', explanation: 'clearer' }), costUsd: 0 };
      }
      return { text: mockSurveyJson, costUsd: 0 };
    }),
  };
});

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', require('../src/routes/ai'));
  return app;
}

// A brief over 8 words so extractSubject does not self-skip.
const BRIEF = 'We want to understand how shoppers in the Gulf choose premium coffee beans for home brewing.';

beforeEach(() => {
  mockClaudeCalls.length = 0;
  mockAuthUser = { id: 'user-42' };
  jest.clearAllMocks();
});

function callsOfType(t) {
  return mockClaudeCalls.filter((c) => c.callType === t);
}

describe('pre-mission AI calls carry the signed-in user', () => {
  test('POST /api/ai/generate-survey stamps userId on survey_gen', async () => {
    const res = await request(buildApp())
      .post('/api/ai/generate-survey')
      .send({ goal: 'research', description: BRIEF });

    expect(res.status).toBe(200);
    const surveyCalls = callsOfType('survey_gen');
    expect(surveyCalls.length).toBeGreaterThan(0);
    for (const c of surveyCalls) {
      expect(c.userId).toBe('user-42');
    }
  });

  test('extractSubject inherits the same userId as the survey it serves', async () => {
    const res = await request(buildApp())
      .post('/api/ai/generate-survey')
      .send({ goal: 'research', description: BRIEF });

    expect(res.status).toBe(200);
    const subjectCalls = callsOfType('subject_extract');
    expect(subjectCalls.length).toBeGreaterThan(0);
    for (const c of subjectCalls) {
      expect(c.userId).toBe('user-42');
    }
  });

  test('POST /api/ai/suggest-targeting stamps userId on targeting_suggest', async () => {
    const res = await request(buildApp())
      .post('/api/ai/suggest-targeting')
      .send({ missionStatement: 'To test', description: BRIEF, goal: 'research' });

    expect(res.status).toBe(200);
    const calls = callsOfType('targeting_suggest');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.userId).toBe('user-42');
    }
  });

  test('POST /api/ai/refine-question stamps userId on question_refine', async () => {
    const res = await request(buildApp())
      .post('/api/ai/refine-question')
      .send({ questionText: 'Do you like it?', questionType: 'single', missionContext: 'ctx' });

    expect(res.status).toBe(200);
    const calls = callsOfType('question_refine');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.userId).toBe('user-42');
    }
  });

  test('an anonymous request still logs the call, just without a user', async () => {
    mockAuthUser = null;
    const res = await request(buildApp())
      .post('/api/ai/generate-survey')
      .send({ goal: 'research', description: BRIEF });

    expect(res.status).toBe(200);
    const surveyCalls = callsOfType('survey_gen');
    expect(surveyCalls.length).toBeGreaterThan(0);
    // Null, not undefined-and-forgotten: there is genuinely no user here.
    for (const c of surveyCalls) {
      expect(c.userId == null).toBe(true);
    }
  });
});

describe('run-time survey generation attributes to the mission it is for', () => {
  // This is the one case where a mission row DEFINITELY exists and the id
  // was simply not passed. ensureMissionQuestions is called from runMission
  // with the full mission row in hand.
  test('ensureMissionQuestions passes missionId and userId to the generator', async () => {
    jest.resetModules();
    const generateSurvey = jest.fn(async () => ({ questions: [{ id: 'q1', text: 'x', type: 'single', options: ['a', 'b'] }] }));
    jest.doMock('../src/services/claudeAI', () => ({ generateSurvey }));
    jest.doMock('../src/db/missionSchema', () => ({ updateMission: jest.fn(async () => ({})) }));
    jest.doMock('../src/utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));

    const { ensureMissionQuestions } = require('../src/services/ai/ensureQuestions');
    const mission = {
      id: 'mission-abc',
      user_id: 'user-42',
      goal_type: 'research',
      questions: [],
      brief: BRIEF,
    };

    await ensureMissionQuestions({}, mission);

    expect(generateSurvey).toHaveBeenCalledTimes(1);
    const args = generateSurvey.mock.calls[0][0];
    expect(args.missionId).toBe('mission-abc');
    expect(args.userId).toBe('user-42');
  });
});
