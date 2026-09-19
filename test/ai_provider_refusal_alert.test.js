'use strict';
// A provider refusal pages an admin. The error shapes are the real ones the
// SDK threw on 2026-09-18 (400, "You have reached your specified API usage
// limits") plus the other refusals that stop every call.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { classifyProviderError, reportProviderRefusal, _resetThrottleForTests } = require('../src/services/ai/providerRefusal');

const sdkError = (status, type, message) => Object.assign(new Error(`${status} ${JSON.stringify({ type: 'error', error: { type, message } })}`), { status, error: { type: 'error', error: { type, message } } });
const SPEND_CAP = sdkError(400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.');

function fakeDeps({ openAlerts = [] } = {}) {
  const inserts = [];
  const emails = [];
  const q = {
    select: () => q, eq: () => q, gte: () => q,
    limit: async () => ({ data: openAlerts }),
    insert: (row) => { inserts.push(row); return { select: async () => ({ data: [{ id: 'a1', ...row, created_at: 'now' }], error: null }) }; },
  };
  return { inserts, emails, deps: { supabase: { from: () => q }, email: { sendAdminAlertDigest: async (m) => { emails.push(m); return { sent: true }; } }, now: () => 1_000_000_000 } };
}

beforeEach(() => _resetThrottleForTests());

test('classifies the refusals by what the owner has to fix', () => {
  expect(classifyProviderError(SPEND_CAP)).toMatchObject({ kind: 'spend_cap', status: 400, blocking: true });
  expect(classifyProviderError(sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the API.'))).toMatchObject({ kind: 'credit_balance', blocking: true });
  expect(classifyProviderError(sdkError(401, 'authentication_error', 'invalid x-api-key'))).toMatchObject({ kind: 'auth', blocking: true });
  expect(classifyProviderError(sdkError(429, 'rate_limit_error', 'rate limited'))).toMatchObject({ kind: 'rate_limit', blocking: false });
  expect(classifyProviderError(sdkError(529, 'overloaded_error', 'Overloaded'))).toMatchObject({ kind: 'overloaded', blocking: false });
  expect(classifyProviderError(new SyntaxError('Unexpected end of JSON input'))).toBeNull();
});

test('a spend-cap refusal raises one admin alert and one email, saying what to do', async () => {
  const { inserts, emails, deps } = fakeDeps();
  const r = await reportProviderRefusal(SPEND_CAP, { callType: 'survey_gen', model: 'm', userId: 'u' }, deps);
  expect(r.raised).toBe(true);
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatchObject({ alert_type: 'ai_provider_refused', payload: { kind: 'spend_cap', http_status: 400, first_call_type: 'survey_gen' } });
  expect(inserts[0].payload.action_required).toMatch(/usage limit/i);
  expect(emails).toHaveLength(1);
});

test('the next refusal within the hour does not page again', async () => {
  const { inserts, emails, deps } = fakeDeps();
  await reportProviderRefusal(SPEND_CAP, {}, deps);
  const second = await reportProviderRefusal(SPEND_CAP, {}, deps);
  expect(second).toMatchObject({ raised: false, reason: 'throttled' });
  expect(inserts).toHaveLength(1);
  expect(emails).toHaveLength(1);
});

test('an open alert from another instance suppresses a duplicate', async () => {
  const { inserts, deps } = fakeDeps({ openAlerts: [{ id: 'x' }] });
  expect(await reportProviderRefusal(SPEND_CAP, {}, deps)).toMatchObject({ raised: false, reason: 'already_open' });
  expect(inserts).toHaveLength(0);
});

test('transient refusals are logged, not paged; other errors are ignored', async () => {
  const { inserts, deps } = fakeDeps();
  expect(await reportProviderRefusal(sdkError(429, 'rate_limit_error', 'x'), {}, deps)).toMatchObject({ raised: false, reason: 'transient' });
  expect(await reportProviderRefusal(new Error('boom'), {}, deps)).toMatchObject({ raised: false, reason: 'not_a_provider_refusal' });
  expect(inserts).toHaveLength(0);
});

test('callClaude reports the refusal and still throws the original error', async () => {
  jest.resetModules();
  const report = jest.fn(async () => ({ raised: true }));
  jest.doMock('../src/services/ai/providerRefusal', () => ({ reportProviderRefusal: report }));
  jest.doMock('../src/db/supabase', () => ({ from: () => ({ insert: () => ({ then: (f) => { f(); return { catch: () => {} }; } }) }) }));
  jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: async () => { throw SPEND_CAP; } } })));
  const { callClaude } = require('../src/services/ai/anthropic');
  await expect(callClaude({ callType: 'survey_gen', messages: [{ role: 'user', content: 'x' }], userId: 'u' })).rejects.toBe(SPEND_CAP);
  expect(report).toHaveBeenCalledWith(SPEND_CAP, expect.objectContaining({ callType: 'survey_gen', userId: 'u' }));
});
