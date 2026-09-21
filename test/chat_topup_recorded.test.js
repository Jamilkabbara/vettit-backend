/**
 * A chat top-up is money, so it gets a row.
 *
 * The webhook credited +50 messages to the chat session and recorded the
 * PaymentIntent in that session's metadata, which made the CREDIT idempotent.
 * It recorded the MONEY nowhere: revenue, invoices and the admin dashboard are
 * computed from `missions`, and a top-up has no mission, so a paid top-up was
 * invisible to every business figure.
 *
 * Audited before the fix: zero top-ups had ever been bought (Stripe search by
 * PaymentIntent metadata, plus a direct scan of 53 Checkout Sessions and 35
 * PaymentIntents; the same search finds mission payments). Nothing was lost.
 * These tests pin what happens to the first one that is sold.
 */

const {
  recordChatTopup, syncChatTopupRefunds, topupNetRevenueCents, sumTopupNetUsd, buildTopupInvoice,
} = require('../src/services/payments/chatTopups');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

/** In-memory stand-in with the real table's unique constraint on the PI id. */
function makeDb(rows = []) {
  const table = [...rows];
  const api = {
    table,
    from(name) {
      if (name !== 'chat_topups') throw new Error(`unexpected table ${name}`);
      const state = { filters: [] };
      const chain = {
        select: () => chain,
        eq: (k, v) => { state.filters.push([k, v]); return chain; },
        maybeSingle: async () => ({ data: table.find((r) => state.filters.every(([k, v]) => r[k] === v)) || null, error: null }),
        upsert: (row, opts) => ({
          select: async () => {
            const clash = table.find((r) => r.stripe_payment_intent_id === row.stripe_payment_intent_id);
            if (clash) {
              if (opts && opts.ignoreDuplicates) return { data: [], error: null };
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
            const saved = { id: `row-${table.length + 1}`, refunded_amount_cents: 0, stripe_refund_ids: [], ...row };
            table.push(saved);
            return { data: [{ id: saved.id }], error: null };
          },
        }),
        update: (patch) => ({
          eq: async (k, v) => {
            const row = table.find((r) => r[k] === v);
            if (row) Object.assign(row, patch);
            return { error: null };
          },
        }),
      };
      return chain;
    },
  };
  return api;
}

const PI = (over = {}) => ({
  id: 'pi_topup_1',
  amount_received: 500,
  currency: 'usd',
  created: 1758400000,
  metadata: { purpose: 'chat_overage', sessionId: 'sess-1', userId: 'user-1', messagesGranted: '50' },
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('recording the payment', () => {
  test('a paid top-up becomes a row with the amount Stripe captured', async () => {
    const db = makeDb();
    const r = await recordChatTopup({ supabase: db, pi: PI(), logger });
    expect(r).toMatchObject({ recorded: true, reason: 'recorded' });
    expect(db.table).toHaveLength(1);
    expect(db.table[0]).toMatchObject({
      stripe_payment_intent_id: 'pi_topup_1', amount_cents: 500, user_id: 'user-1', chat_session_id: 'sess-1',
    });
  });

  test('THE POINT: delivering the same event twice does not double the money', async () => {
    const db = makeDb();
    await recordChatTopup({ supabase: db, pi: PI(), logger });
    const second = await recordChatTopup({ supabase: db, pi: PI(), logger });
    expect(second).toMatchObject({ recorded: false, reason: 'already_recorded' });
    expect(db.table).toHaveLength(1);
    expect(sumTopupNetUsd(db.table)).toBe(5);
  });

  test('the amount comes from the PaymentIntent, never from metadata', async () => {
    const db = makeDb();
    // A forged event claiming a larger sale, with $5 actually captured.
    await recordChatTopup({ supabase: db, pi: PI({ metadata: { ...PI().metadata, amount: '500000', messagesGranted: '50' } }), logger });
    expect(db.table[0].amount_cents).toBe(500);
  });

  test('a payment that captured nothing is not revenue', async () => {
    const db = makeDb();
    const r = await recordChatTopup({ supabase: db, pi: PI({ amount_received: 0 }), logger });
    expect(r.recorded).toBe(false);
    expect(db.table).toHaveLength(0);
  });

  test('a mission payment is left to the mission path', async () => {
    const db = makeDb();
    const r = await recordChatTopup({ supabase: db, pi: PI({ metadata: { purpose: 'mission_payment' } }), logger });
    expect(r).toMatchObject({ recorded: false, reason: 'not_a_topup' });
  });

  test('a top-up with no owner is refused loudly, not dropped quietly', async () => {
    const db = makeDb();
    const r = await recordChatTopup({ supabase: db, pi: PI({ metadata: { purpose: 'chat_overage', sessionId: 's' } }), logger });
    expect(r).toMatchObject({ recorded: false, reason: 'no_user_id' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('refunds, the same rule as missions', () => {
  const stripeWith = (refunds) => ({ refunds: { list: async () => ({ data: refunds }) } });

  test('a refunded top-up stops counting as revenue', async () => {
    const db = makeDb();
    await recordChatTopup({ supabase: db, pi: PI(), logger });
    const r = await syncChatTopupRefunds({
      stripe: stripeWith([{ id: 're_1', amount: 500, status: 'succeeded' }]),
      supabase: db, paymentIntentId: 'pi_topup_1', logger,
    });
    expect(r).toMatchObject({ matched: true, written: true, refundedCents: 500 });
    expect(topupNetRevenueCents(db.table[0])).toBe(0);
    expect(buildTopupInvoice(db.table[0]).status).toBe('refunded');
  });

  test('a partial refund leaves the rest', async () => {
    const db = makeDb();
    await recordChatTopup({ supabase: db, pi: PI(), logger });
    await syncChatTopupRefunds({
      stripe: stripeWith([{ id: 're_1', amount: 200, status: 'succeeded' }]),
      supabase: db, paymentIntentId: 'pi_topup_1', logger,
    });
    expect(topupNetRevenueCents(db.table[0])).toBe(300);
    expect(buildTopupInvoice(db.table[0])).toMatchObject({ total: 5, refunded: 2, net: 3, status: 'partially_refunded' });
  });

  test('a cancelled refund puts the money back', async () => {
    const db = makeDb();
    await recordChatTopup({ supabase: db, pi: PI(), logger });
    const stripe = { refunds: { list: async () => ({ data: refunds }) } };
    let refunds = [{ id: 're_1', amount: 500, status: 'succeeded' }];
    await syncChatTopupRefunds({ stripe, supabase: db, paymentIntentId: 'pi_topup_1', logger });
    expect(topupNetRevenueCents(db.table[0])).toBe(0);

    refunds = [{ id: 're_1', amount: 500, status: 'canceled' }];
    await syncChatTopupRefunds({ stripe, supabase: db, paymentIntentId: 'pi_topup_1', logger });
    expect(topupNetRevenueCents(db.table[0])).toBe(500);
  });

  test('syncing twice writes once', async () => {
    const db = makeDb();
    await recordChatTopup({ supabase: db, pi: PI(), logger });
    const stripe = stripeWith([{ id: 're_1', amount: 500, status: 'succeeded' }]);
    const first = await syncChatTopupRefunds({ stripe, supabase: db, paymentIntentId: 'pi_topup_1', logger });
    const second = await syncChatTopupRefunds({ stripe, supabase: db, paymentIntentId: 'pi_topup_1', logger });
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
  });

  test('a refund for someone else\'s payment matches nothing', async () => {
    const db = makeDb();
    const r = await syncChatTopupRefunds({ stripe: stripeWith([]), supabase: db, paymentIntentId: 'pi_other', logger });
    expect(r).toMatchObject({ matched: false, written: false });
  });
});

describe('what the customer and the dashboard see', () => {
  test('the invoice says what it was, and nets off refunds', () => {
    const inv = buildTopupInvoice({
      id: 'abcdef12-0000', amount_cents: 500, refunded_amount_cents: 0, messages_granted: 50, paid_at: '2026-09-21T10:00:00Z',
    });
    expect(inv).toMatchObject({ kind: 'chat_topup', total: 5, net: 5, status: 'paid', paidVia: 'stripe' });
    expect(inv.missionStatement).toContain('50 extra messages');
    expect(inv.invoiceId.startsWith('VTT-CHAT-')).toBe(true);
  });

  test('revenue sums net, not gross', () => {
    expect(sumTopupNetUsd([
      { amount_cents: 500, refunded_amount_cents: 0 },
      { amount_cents: 500, refunded_amount_cents: 500 },
      { amount_cents: 500, refunded_amount_cents: 200 },
    ])).toBe(8);
  });
});
