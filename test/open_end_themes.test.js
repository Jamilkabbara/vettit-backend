/**
 * Pass 50 P2-1 — open-end theme clustering: parsing, grounding, validation.
 * callClaude is mocked, so this pins the deterministic post-processing (the
 * part that must never hallucinate) without a live LLM call.
 */
const mockCall = jest.fn();
jest.mock('../src/services/ai/anthropic', () => ({ callClaude: (...a) => mockCall(...a) }));

const { clusterOpenEndThemes } = require('../src/services/ai/openEndThemes');

const verbatims = [
  'My main concern is pricing — I need clear ROI before committing',
  'Pricing is honestly too high for what you get',
  'Hygiene and infection control really worry me',
  'I worry about whether staff would actually care for my cat',
  'Transport is an issue, I do not own a car',
];

beforeEach(() => mockCall.mockReset());

test('too few verbatims → no themes, no LLM call', async () => {
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, ['only one', 'and two']);
  expect(out.themes).toEqual([]);
  expect(mockCall).not.toHaveBeenCalled();
});

test('parses themes, clamps counts to n, validates sentiment, sorts by count desc, computes pct', async () => {
  mockCall.mockResolvedValue({ text: JSON.stringify({ themes: [
    { label: 'Hygiene concerns', count: 2, sentiment: 'negative', quotes: ['Hygiene and infection control really worry me'] },
    { label: 'Pricing / ROI', count: 99, sentiment: 'not-a-sentiment', quotes: ['Pricing is honestly too high for what you get'] },
  ] }) });
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, verbatims);
  expect(out.n).toBe(5);
  // sorted by count desc — pricing (clamped 99→5) leads
  expect(out.themes[0].label).toBe('Pricing / ROI');
  expect(out.themes[0].count).toBe(5);          // clamped to n
  expect(out.themes[0].pct).toBe(100);          // 5/5
  expect(out.themes[0].sentiment).toBe('neutral'); // invalid → neutral
  expect(out.themes[1].label).toBe('Hygiene concerns');
  expect(out.themes[1].count).toBe(2);
  expect(out.themes[1].pct).toBe(40);           // 2/5
  expect(out.themes[1].sentiment).toBe('negative');
});

test('drops fabricated quotes, keeps verbatim ones (grounding)', async () => {
  mockCall.mockResolvedValue({ text: JSON.stringify({ themes: [
    { label: 'Staff trust', count: 1, sentiment: 'negative', quotes: ['This was never said by any respondent at all'] },
    { label: 'Transport', count: 1, sentiment: 'neutral', quotes: ['Transport is an issue, I do not own a car'] },
  ] }) });
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, verbatims);
  expect(out.themes.find((t) => t.label === 'Staff trust').quotes).toEqual([]);       // fabricated → dropped
  expect(out.themes.find((t) => t.label === 'Transport').quotes)
    .toEqual(['Transport is an issue, I do not own a car']);                          // real → kept
});

test('caps at 6 themes', async () => {
  mockCall.mockResolvedValue({ text: JSON.stringify({ themes:
    Array.from({ length: 9 }, (_, i) => ({ label: `Theme ${i}`, count: 1, sentiment: 'neutral', quotes: [] })) }) });
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, verbatims);
  expect(out.themes.length).toBe(6);
});

test('non-fatal: LLM error → no themes (renders verbatims)', async () => {
  mockCall.mockRejectedValue(new Error('401 invalid x-api-key'));
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, verbatims);
  expect(out.themes).toEqual([]);
  expect(out.n).toBe(5);
});

test('malformed (non-JSON) LLM output → no themes', async () => {
  mockCall.mockResolvedValue({ text: 'sorry, I cannot do that' });
  const out = await clusterOpenEndThemes({ id: 'q5', text: 'concerns?' }, verbatims);
  expect(out.themes).toEqual([]);
});
