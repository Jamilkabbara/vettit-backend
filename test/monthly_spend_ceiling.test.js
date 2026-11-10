/**
 * The monthly AI spend ceiling is a tripwire, not a budget.
 *
 * All-time AI spend across the whole product is $36.15. A single month at $50
 * is roughly ten times a normal month, so it does not mean "we are busy" - it
 * means something is wrong: a runaway loop, a leaked key someone else is
 * spending, or one study spiralling.
 *
 * Three things have to be true of it, and all three are tested here:
 *
 *   1. It measures from `ai_calls`, the spend LOG - never from
 *      `missions.ai_cost_usd`. The mission column misses every call that
 *      carries no mission_id: 1,931 calls worth $15.26, 42% of true spend. A
 *      ceiling reading the mission column would sit at 58% of reality and
 *      would not fire when it mattered.
 *
 *   2. It reads the log to the END. PostgREST caps an unbounded SELECT at
 *      1000 rows and returns a 200, so an unpaged sum is silently short. The
 *      runaway month this exists to catch is exactly the month with more than
 *      1000 calls in it, which is to say: an unpaged ceiling is broken in
 *      precisely the case it was built for.
 *
 *   3. It is quiet below the line and loud above it. An alarm that never
 *      fires is worthless; one that always fires gets ignored. Both
 *      directions are proved, and the real month-to-date figure is asserted
 *      to stay silent so the thing cannot ship already ringing.
 */
'use strict';

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  readConfig,
  monthKey,
  monthStartIso,
  readMonthToDateSpend,
  checkMonthlyCeiling,
  runMonthlyCeilingCheck,
  spendAllowsNewWork,
  CEILING_DEFAULT_USD,
  HARD_LIMIT_MULTIPLE,
} = require('../src/services/ai/monthlySpendCeiling');

// 2026-11-10, mid-month, so a month-start boundary is a real boundary.
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const now = () => NOW;

/**
 * Supabase double over `ai_calls` that behaves like PostgREST does: it honours
 * .range() and never returns more than the page asked for. A read that does
 * not page therefore sees only the first 1000 rows here, the same way it
 * would in production.
 */
function fakeDb({ aiCalls = [], openAlerts = [], aiCallsError = null, missions = [] } = {}) {
  const inserts = [];
  const emails = [];
  const reads = [];
  const alertFilters = [];

  const aiCallsQuery = () => {
    const state = { gte: null };
    const q = {
      select: () => q,
      gte: (col, val) => { state.gte = { col, val }; return q; },
      order: () => q,
      range: async (from, to) => {
        if (aiCallsError) return { data: null, error: aiCallsError };
        const rows = state.gte
          ? aiCalls.filter((r) => r.created_at >= state.gte.val)
          : aiCalls.slice();
        reads.push({ from, to, gte: state.gte });
        return { data: rows.slice(from, to + 1), error: null };
      },
    };
    return q;
  };

  const alertsQuery = () => {
    const filters = {};
    const q = {
      select: () => q,
      eq: (col, val) => { filters[col] = val; return q; },
      gte: (col, val) => { filters[col] = val; return q; },
      limit: async () => { alertFilters.push({ ...filters }); return { data: openAlerts, error: null }; },
      insert: (row) => {
        inserts.push(row);
        return { select: async () => ({ data: [{ id: 'alert-1', ...row, created_at: new Date(NOW).toISOString() }], error: null }) };
      },
    };
    return q;
  };

  const missionsQuery = () => {
    const q = {
      select: () => q, gte: () => q, order: () => q,
      range: async () => ({ data: missions, error: null }),
    };
    return q;
  };

  const supabase = {
    from: (table) => {
      if (table === 'ai_calls') return aiCallsQuery();
      if (table === 'admin_alerts') return alertsQuery();
      if (table === 'missions') return missionsQuery();
      throw new Error(`unexpected table read: ${table}`);
    },
  };

  return {
    supabase, inserts, emails, reads, alertFilters,
    email: { sendAdminAlertDigest: async (m) => { emails.push(m); return { sent: true }; } },
  };
}

/** n calls in the current month, each costing `each`, all of one call_type. */
const calls = (n, each, callType = 'response_sim', createdAt = '2026-11-05T00:00:00.000Z') =>
  Array.from({ length: n }, (_, i) => ({
    id: `c-${callType}-${i}`, call_type: callType, cost_usd: each, created_at: createdAt,
  }));

// ─── Configuration ─────────────────────────────────────────────────────────

describe('the ceiling is configurable and defaults to $50', () => {
  test('with nothing set, the ceiling is $50 and the hard limit is 3x it', () => {
    expect(CEILING_DEFAULT_USD).toBe(50);
    expect(readConfig({})).toEqual({ ceilingUsd: 50, hardLimitUsd: 50 * HARD_LIMIT_MULTIPLE });
  });

  test('an env var moves the ceiling, and the hard limit follows it', () => {
    expect(readConfig({ AI_MONTHLY_CEILING_USD: '120' }))
      .toEqual({ ceilingUsd: 120, hardLimitUsd: 360 });
  });

  test('the hard limit can be set on its own', () => {
    expect(readConfig({ AI_MONTHLY_CEILING_USD: '50', AI_MONTHLY_HARD_LIMIT_USD: '80' }))
      .toEqual({ ceilingUsd: 50, hardLimitUsd: 80 });
  });

  test('junk, empty and negative values fall back to the default, never to unlimited', () => {
    for (const bad of ['', '  ', 'fifty', '0', '-10', 'NaN', 'Infinity']) {
      expect(readConfig({ AI_MONTHLY_CEILING_USD: bad }).ceilingUsd).toBe(50);
    }
  });

  test('a hard limit below the ceiling is ignored - the hard limit can never bite first', () => {
    expect(readConfig({ AI_MONTHLY_CEILING_USD: '50', AI_MONTHLY_HARD_LIMIT_USD: '20' }).hardLimitUsd)
      .toBe(150);
  });
});

describe('the month is the calendar month, in UTC', () => {
  test('the key and the start of the window come from the clock, not a rolling 30 days', () => {
    expect(monthKey(NOW)).toBe('2026-11');
    expect(monthStartIso(NOW)).toBe('2026-11-01T00:00:00.000Z');
    expect(monthKey(Date.UTC(2027, 0, 1, 0, 0, 1))).toBe('2027-01');
  });
});

// ─── It reads the log, and reads it to the end ─────────────────────────────

describe('it measures from ai_calls, the spend log', () => {
  test('calls with no mission_id are counted - they are 42% of real spend', async () => {
    const { supabase } = fakeDb({
      aiCalls: [
        { id: 'a', call_type: 'response_sim', cost_usd: 1.5, created_at: '2026-11-02T00:00:00.000Z', mission_id: 'm1' },
        { id: 'b', call_type: 'adaptive_clarify', cost_usd: 2.5, created_at: '2026-11-03T00:00:00.000Z', mission_id: null },
      ],
      // If the ceiling ever read this instead, it would see 1.5 and sit quiet.
      missions: [{ id: 'm1', ai_cost_usd: 1.5 }],
    });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out.spendUsd).toBeCloseTo(4.0, 6);
    expect(out.calls).toBe(2);
  });

  test('last month is outside the window', async () => {
    const { supabase } = fakeDb({
      aiCalls: [
        ...calls(1, 9.87, 'response_sim', '2026-10-31T23:59:59.000Z'),
        ...calls(1, 1.0, 'response_sim', '2026-11-01T00:00:00.000Z'),
      ],
    });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out.spendUsd).toBeCloseTo(1.0, 6);
    expect(out.month).toBe('2026-11');
  });

  test('it reads past 1000 rows - an unpaged sum would stop at the row cap', async () => {
    // 2,500 calls at $0.02 = $50.00 exactly. An unpaged read sees 1000 of
    // them and sums $20, which is under the ceiling: the runaway month would
    // go unreported by the thing built to report it.
    const { supabase, reads } = fakeDb({ aiCalls: calls(2500, 0.02) });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out.calls).toBe(2500);
    expect(out.spendUsd).toBeCloseTo(50, 6);
    expect(reads.length).toBeGreaterThan(1);
  });

  test('every page is filtered to the month - paging cannot widen the window', async () => {
    const { supabase, reads } = fakeDb({ aiCalls: calls(2500, 0.02) });
    await readMonthToDateSpend({ supabase, now });
    for (const r of reads) {
      expect(r.gte).toMatchObject({ col: 'created_at', val: '2026-11-01T00:00:00.000Z' });
    }
  });

  test('numeric columns that arrive as strings still add up', async () => {
    const { supabase } = fakeDb({
      aiCalls: [
        { id: 'a', call_type: 'response_sim', cost_usd: '1.25', created_at: '2026-11-02T00:00:00.000Z' },
        { id: 'b', call_type: 'response_sim', cost_usd: null, created_at: '2026-11-02T00:00:00.000Z' },
      ],
    });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out.spendUsd).toBeCloseTo(1.25, 6);
  });
});

describe('it names the biggest contributor so the reader knows where to look', () => {
  test('the top call_type by spend, with its own total and call count', async () => {
    const { supabase } = fakeDb({
      aiCalls: [
        ...calls(10, 1.0, 'response_sim'),
        ...calls(2, 2.0, 'insight_synth'),
        ...calls(50, 0.01, 'subject_extract'),
      ],
    });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out.topContributor).toMatchObject({ call_type: 'response_sim', calls: 10 });
    expect(out.topContributor.spendUsd).toBeCloseTo(10, 6);
    // Most calls is not most money: the loudest row must be the costliest.
    expect(out.byCallType[0].call_type).toBe('response_sim');
  });

  test('an empty month has no contributor and no spend, and does not throw', async () => {
    const { supabase } = fakeDb({ aiCalls: [] });
    const out = await readMonthToDateSpend({ supabase, now });
    expect(out).toMatchObject({ spendUsd: 0, calls: 0, topContributor: null });
  });
});

// ─── Fire and no-fire ──────────────────────────────────────────────────────

describe('it fires above the ceiling', () => {
  test('crossing $50 raises one admin alert on the existing channel', async () => {
    const db = fakeDb({ aiCalls: calls(60, 1.0, 'response_sim') }); // $60
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });

    expect(out.breached).toBe(true);
    expect(out.alert).toMatchObject({ raised: true });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].alert_type).toBe('ai_monthly_spend_ceiling');
    expect(db.inserts[0].resolved).toBe(false);
  });

  test('the alert says the month, the spend, the ceiling and the biggest contributor', async () => {
    const db = fakeDb({
      aiCalls: [...calls(60, 1.0, 'response_sim'), ...calls(4, 0.5, 'persona_gen')], // $62
    });
    await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });

    const p = db.inserts[0].payload;
    expect(p.month).toBe('2026-11');
    expect(p.spend_usd).toBeCloseTo(62, 4);
    expect(p.ceiling_usd).toBe(50);
    expect(p.hard_limit_usd).toBe(150);
    expect(p.biggest_contributor).toMatchObject({ call_type: 'response_sim', calls: 60 });
    expect(p.biggest_contributor.spend_usd).toBeCloseTo(60, 4);
    expect(p.severity).toBe('ceiling');
    expect(p.action_required).toBeTruthy();
  });

  test('it pages now rather than waiting for tomorrow morning', async () => {
    // A runaway loop keeps spending while the nightly digest waits, so the
    // tripwire mails immediately - the same way a provider refusal does.
    const db = fakeDb({ aiCalls: calls(60, 1.0) });
    await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0].alerts[0].alert_type).toBe('ai_monthly_spend_ceiling');
  });

  test('exactly at the ceiling counts as reached', async () => {
    const db = fakeDb({ aiCalls: calls(50, 1.0) });
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.breached).toBe(true);
  });

  test('crossing the hard limit is a second, louder alert', async () => {
    const db = fakeDb({ aiCalls: calls(200, 1.0) }); // $200 > $150
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.hardBreached).toBe(true);
    expect(db.inserts[0].payload.severity).toBe('hard_limit');
    expect(db.inserts[0].payload.what_happens_now).toMatch(/new/i);
  });
});

describe('it stays quiet below the ceiling', () => {
  test('no alert, no email, no noise', async () => {
    const db = fakeDb({ aiCalls: calls(40, 1.0) }); // $40 of $50
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.breached).toBe(false);
    expect(out.alert).toMatchObject({ raised: false });
    expect(db.inserts).toHaveLength(0);
    expect(db.emails).toHaveLength(0);
  });

  test('a cent under is still under', async () => {
    const db = fakeDb({ aiCalls: calls(1, 49.99) });
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.breached).toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  test('it does not fire on the real month-to-date figure it is shipping against', async () => {
    // Production on 2026-11-10: 684 calls, $5.9435 month to date. If this
    // implementation would alert on that, the ceiling is wrong, not the data.
    const db = fakeDb({ aiCalls: calls(684, 5.9435 / 684) });
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.spendUsd).toBeCloseTo(5.9435, 4);
    expect(out.breached).toBe(false);
    expect(db.inserts).toHaveLength(0);
    expect(db.emails).toHaveLength(0);
  });

  test('no month in the whole history of the product would have fired it', async () => {
    // Every calendar month ever recorded, from the live table. The worst is
    // $9.87. A ceiling that would have fired retroactively is a bug.
    const everyMonth = [1.5528, 1.3562, 8.8134, 2.0563, 6.5600, 9.8721, 5.9435];
    for (const spend of everyMonth) {
      const db = fakeDb({ aiCalls: calls(1, spend) });
      const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
      expect(out.breached).toBe(false);
      expect(db.inserts).toHaveLength(0);
    }
  });
});

describe('it alerts once per month, not once per tick', () => {
  test('an open alert for this month and severity suppresses the next one', async () => {
    const db = fakeDb({
      aiCalls: calls(60, 1.0),
      openAlerts: [{ id: 'already-open' }],
    });
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out.alert).toMatchObject({ raised: false, reason: 'already_open' });
    expect(db.inserts).toHaveLength(0);
    expect(db.emails).toHaveLength(0);
  });

  test('the dedup is scoped to THIS month, so next month can fire again', async () => {
    const db = fakeDb({ aiCalls: calls(60, 1.0) });
    await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    const filters = db.alertFilters[0];
    expect(filters.alert_type).toBe('ai_monthly_spend_ceiling');
    expect(filters.resolved).toBe(false);
    expect(filters['payload->>month']).toBe('2026-11');
  });
});

// ─── The gate on new work ──────────────────────────────────────────────────

describe('above the hard limit, new work does not start', () => {
  test('below the ceiling, new work starts', async () => {
    const { supabase } = fakeDb({ aiCalls: calls(40, 1.0) });
    expect(await spendAllowsNewWork({ supabase, now, env: {} }))
      .toMatchObject({ allowed: true, reason: 'under_ceiling' });
  });

  test('between the ceiling and the hard limit, new work STILL starts', async () => {
    // This is the whole design: $50 wakes a human, it does not stop the
    // product. A customer who paid at $51 of spend gets their study.
    const { supabase } = fakeDb({ aiCalls: calls(100, 1.0) }); // $100
    const out = await spendAllowsNewWork({ supabase, now, env: {} });
    expect(out).toMatchObject({ allowed: true, reason: 'over_ceiling_under_hard_limit' });
  });

  test('above the hard limit, new work is refused', async () => {
    const { supabase } = fakeDb({ aiCalls: calls(200, 1.0) }); // $200 > $150
    const out = await spendAllowsNewWork({ supabase, now, env: {} });
    expect(out).toMatchObject({ allowed: false, reason: 'over_hard_limit' });
    expect(out.state.spendUsd).toBeCloseTo(200, 4);
  });

  test('a run already in flight is never refused, whatever the spend', async () => {
    // A resumed run is a paid study with half its data already written. The
    // customer has been charged and there are no re-run credits, so killing
    // it converts a cost problem into a refund.
    const { supabase } = fakeDb({ aiCalls: calls(5000, 1.0) }); // $5,000
    expect(await spendAllowsNewWork({ supabase, now, env: {}, resume: true }))
      .toMatchObject({ allowed: true, reason: 'in_flight_run' });
  });

  test('if the log cannot be read, the gate fails OPEN and says so', async () => {
    // The tripwire must not become the outage. A paid study is not blocked
    // because a SELECT failed.
    const { supabase } = fakeDb({ aiCallsError: { message: 'connection reset' } });
    const out = await spendAllowsNewWork({ supabase, now, env: {} });
    expect(out).toMatchObject({ allowed: true, reason: 'spend_unreadable' });
  });

  test('a supabase client that THROWS also fails open, not closed', async () => {
    // Caught by the existing runMission suites, not by this one, on the first
    // build: a failed read arrives two ways - PostgREST answering with an
    // error object, and the client raising. Only the first was handled, so an
    // exception escaped the gate and refused every paid mission. Failing
    // closed is the worse outage of the two this module sits between.
    const exploding = { from: () => { throw new Error('client not configured'); } };
    expect(await spendAllowsNewWork({ supabase: exploding, now, env: {} }))
      .toMatchObject({ allowed: true, reason: 'spend_unreadable' });
  });

  test('a client that throws mid-query fails open too', async () => {
    const halfBuilt = { from: () => ({ select: () => ({ gte: () => { throw new Error('boom'); } }) }) };
    expect(await spendAllowsNewWork({ supabase: halfBuilt, now, env: {} }))
      .toMatchObject({ allowed: true, reason: 'spend_unreadable' });
  });

  test('an unreadable log does not raise a spend alert either', async () => {
    const db = fakeDb({ aiCallsError: { message: 'connection reset' } });
    const out = await runMonthlyCeilingCheck({ supabase: db.supabase, email: db.email, now, env: {} });
    expect(out).toMatchObject({ failed: true });
    expect(db.inserts).toHaveLength(0);
  });
});

describe('checkMonthlyCeiling reports without acting', () => {
  test('it returns the state and writes nothing', async () => {
    const db = fakeDb({ aiCalls: calls(60, 1.0) });
    const state = await checkMonthlyCeiling({ supabase: db.supabase, now, env: {} });
    expect(state).toMatchObject({
      month: '2026-11', ceilingUsd: 50, hardLimitUsd: 150, breached: true, hardBreached: false,
    });
    expect(db.inserts).toHaveLength(0);
    expect(db.emails).toHaveLength(0);
  });
});
