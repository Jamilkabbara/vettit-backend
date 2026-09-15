'use strict';
// The customer emails link to pages that exist and state the same remedy the
// Refund Policy and Help page state.
const mockSent = [];
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn(async (m) => { mockSent.push(m); return { id: 'x' }; }) } })) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const email = require('../src/services/email');

beforeEach(() => { mockSent.length = 0; });

test('survey completion email links to /results/:id, a route the website has', async () => {
  await email.sendMissionCompletedEmail({ to: 'a@b.c', name: 'A', missionStatement: 'M', totalResponses: 50, missionId: 'm-1' });
  expect(mockSent[0].html).toContain('/results/m-1');
  expect(mockSent[0].html).not.toContain('/results?missionId=');
});

test('Creative Attention completion email exists and links to /creative-results/:id', async () => {
  await email.sendCreativeAnalysisCompletedEmail({ to: 'a@b.c', name: 'A', missionTitle: 'CA', missionId: 'm-2', placementLabel: 'Instagram Feed' });
  expect(mockSent[0].subject).toBe('Your creative analysis is ready');
  expect(mockSent[0].html).toContain('/creative-results/m-2');
  expect(mockSent[0].html).toContain('Instagram Feed');
  expect(mockSent[0].html).not.toMatch(/respondents have shared|Chat with your results/);
});

test('failure email states the one remedy, promises no credit, and links to the right page', async () => {
  await email.sendMissionFailedEmail({ to: 'a@b.c', name: 'A', missionTitle: 'CA', missionId: 'm-3', missionPath: '/creative-results/m-3' });
  const html = mockSent[0].html;
  expect(html).toContain(email.MISSION_FAILURE_REMEDY);
  expect(html).toContain('/creative-results/m-3');
  expect(html).not.toMatch(/credit/i);
  expect(html).not.toMatch(/one business day/);
  expect(html).not.toMatch(/start fresh/i);
});
