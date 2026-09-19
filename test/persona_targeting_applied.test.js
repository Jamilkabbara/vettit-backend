'use strict';
/**
 * Persona generation must run with the targeting the customer sees.
 *
 * The setup page never writes missions.targeting; the dashboard shows the AI
 * suggestion (target_audience.aiTargeting) as the targeting. Persona
 * generation read missions.targeting alone and prompted "Countries: Global".
 * Mission 10ecb820 (UAE iced coffee, 240 respondents) came back 239 of 240 US.
 * The fixtures below are that mission's real shape.
 */
process.env.NODE_ENV = 'test';
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prompts = [];
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(async ({ messages }) => {
    prompts.push(messages[0].content);
    const start = Number(/Starting persona ID index: P(\d+)/.exec(messages[0].content)[1]);
    const n = Number(/Generate (\d+) synthetic respondents/.exec(messages[0].content)[1]);
    const personas = Array.from({ length: n }, (_, i) => ({ id: `P${String(start + i).padStart(3, '0')}`, country: 'AE' }));
    return { text: JSON.stringify({ personas }) };
  }),
  extractJSON: (t) => JSON.parse(t),
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { resolveEffectiveTargeting } = require('../src/services/missions/effectiveTargeting');

const icedCoffee = {
  id: '10ecb820-test', goal_type: 'compare', user_id: 'u',
  brief: 'Compare Concepts: We are launching a premium ready-to-drink iced coffee in the UAE and have three positioning concepts.',
  targeting: null,
  target_audience: {
    market: 'uae_gulf',
    aiTargeting: { genders: [], ageRanges: ['18-24', '25-34', '35-44'], countries: ['AE'] },
    suggestions: { genders: [], ageRanges: ['18-24', '25-34', '35-44'], countries: ['AE'] },
  },
  questions: [],
};

beforeEach(() => { prompts.length = 0; });

test('the AI-suggested countries and ages reach the persona prompt when nothing was saved', async () => {
  await generatePersonas(icedCoffee, 20);
  expect(prompts.length).toBeGreaterThan(0);
  for (const p of prompts) {
    expect(p).toContain('- Countries: AE');
    expect(p).toContain('- Age ranges: 18-24, 25-34, 35-44');
    expect(p).not.toContain('Countries: Global');
  }
});

test('saved targeting wins over the suggestion', async () => {
  await generatePersonas({ ...icedCoffee, targeting: { geography: { countries: ['SA', 'EG'] } } }, 10);
  expect(prompts[0]).toContain('- Countries: SA, EG');
});

test('with no saved targeting and no suggestion, the clarify market preset applies, as on the dashboard', async () => {
  await generatePersonas({ ...icedCoffee, target_audience: { market: 'uae_gulf', aiTargeting: null } }, 10);
  expect(prompts[0]).toContain('- Countries: AE, SA, KW, QA, BH, OM');
});

test('only a mission with nothing at all falls back to Global', async () => {
  await generatePersonas({ ...icedCoffee, target_audience: { market: 'global', aiTargeting: null } }, 10);
  expect(prompts[0]).toContain('- Countries: Global');
});

describe('resolveEffectiveTargeting', () => {
  test('reports where the targeting came from', () => {
    expect(resolveEffectiveTargeting(icedCoffee)).toMatchObject({ source: 'ai_suggested', countries: ['AE'] });
    expect(resolveEffectiveTargeting({ targeting: { countries: ['LB'] } })).toMatchObject({ source: 'saved', countries: ['LB'] });
    expect(resolveEffectiveTargeting({ target_audience: { market: 'mena' } }).source).toBe('market_preset');
    expect(resolveEffectiveTargeting({})).toMatchObject({ source: 'none', countries: [] });
  });

  test('the preset table matches the dashboard', () => {
    const fs = require('fs');
    const path = require('path');
    const dash = path.join(__dirname, '..', '..', 'Documents', 'GitHub', 'vett-platform', 'src', 'pages', 'DashboardPage.tsx');
    if (!fs.existsSync(dash)) return; // the website repo is not checked out beside this one in CI
    const src = fs.readFileSync(dash, 'utf8');
    const { MARKET_COUNTRY_PRESETS } = require('../src/services/missions/effectiveTargeting');
    for (const [market, countries] of Object.entries(MARKET_COUNTRY_PRESETS)) {
      const m = new RegExp(`${market}:\\s*\\[([^\\]]*)\\]`).exec(src);
      expect(m).not.toBeNull();
      expect([...m[1].matchAll(/'([A-Z]{2})'/g)].map((x) => x[1])).toEqual(countries);
    }
  });
});
