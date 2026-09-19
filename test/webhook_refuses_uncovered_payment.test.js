'use strict';
// The payment webhook must consult the coverage guard BEFORE marking a mission
// paid, and a refused payment must never mark it paid or start a run.
process.env.NODE_ENV = 'test';
const express = require('express');
const request = require('supertest');

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockEvent = { current: null };
jest.mock('../src/services/stripe', () => ({ constructWebhookEvent: () => mockEvent.current, stripeClient: {} }));
const mockGuard = jest.fn();
jest.mock('../src/services/payments/checkoutInvalidation', () => ({ guardPaymentCoversMission: (...a) => mockGuard(...a) }));
jest.mock('../src/services/payments/paymentCoversRun', () => ({ checkPaymentCoversRun: jest.fn() }));
const mockUpdateMission = jest.fn(async () => ({ error: null }));
jest.mock('../src/db/missionSchema', () => ({ updateMission: (...a) => mockUpdateMission(...a) }));
const mockRunMission = jest.fn(async () => {});
jest.mock('../src/jobs/runMission', () => ({ runMission: (...a) => mockRunMission(...a) }));
jest.mock('../src/services/email', () => ({}));
jest.mock('../src/services/promo/promoCodes', () => ({ recordPaidRedemption: jest.fn() }));
jest.mock('../src/services/paymentErrors', () => ({ logPaymentError: jest.fn(), shapeStripeError: (e) => e }));
jest.mock('../src/services/payments/syncMissionRefunds', () => ({ syncMissionRefunds: jest.fn() }));
jest.mock('../src/db/supabase', () => {
  const chain = () => {
    const q = {
      insert: () => q, update: () => q, select: () => q, eq: () => q, is: () => q,
      single: async () => ({ data: { event_id: 'evt' }, error: null }),
      maybeSingle: async () => ({ data: { latest_payment_intent_id: null, status: 'draft', user_id: 'u1', promo_code: null }, error: null }),
      then: (r) => Promise.resolve({ data: null, error: null }).then(r),
    };
    return q;
  };
  return { from: chain };
});

const app = express();
app.use('/api/webhooks', require('../src/routes/webhooks'));

const payEvent = { id: 'evt_pay', type: 'payment_intent.succeeded', data: { object: { id: 'pi_9', amount: 900, amount_received: 900, metadata: { missionId: 'm-1250' } } } };

beforeEach(() => { mockGuard.mockReset(); mockUpdateMission.mockClear(); mockRunMission.mockClear(); mockEvent.current = payEvent; });

const paidWrites = () => mockUpdateMission.mock.calls.filter(([, , patch]) => patch && patch.status === 'paid');

test('a refused payment never marks the mission paid or starts a run', async () => {
  mockGuard.mockResolvedValue({ accepted: false, reason: 'uncovered_refunded' });
  const res = await request(app).post('/api/webhooks/stripe').set('stripe-signature', 'x').send('{}');
  expect(res.status).toBe(200);
  expect(mockGuard).toHaveBeenCalledWith(expect.objectContaining({ pi: payEvent.data.object }));
  expect(paidWrites()).toHaveLength(0);
  expect(mockRunMission).not.toHaveBeenCalled();
});

test('a covering payment still marks the mission paid', async () => {
  mockGuard.mockResolvedValue({ accepted: true, reason: 'covers' });
  await request(app).post('/api/webhooks/stripe').set('stripe-signature', 'x').send('{}');
  expect(paidWrites()).toHaveLength(1);
});

test('if the guard itself fails, the webhook answers 500 so Stripe retries, and nothing is marked paid', async () => {
  mockGuard.mockRejectedValue(new Error('stripe down'));
  const res = await request(app).post('/api/webhooks/stripe').set('stripe-signature', 'x').send('{}');
  expect(res.status).toBe(500);
  expect(paidWrites()).toHaveLength(0);
});
