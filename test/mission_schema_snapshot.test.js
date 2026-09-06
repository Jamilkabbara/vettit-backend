/**
 * VETT — missions schema drift guard.
 *
 * THE POINT OF THIS FILE: catch the NEXT column that gets added to
 * public.missions and not classified. The hand-maintained ALLOWED_COLUMNS
 * list silently drifted 18 columns behind the table, and because
 * sanitizeMissionPatch drops unknown keys with only a logger.warn, three
 * columns that POST /api/missions writes today (price_breakdown,
 * targeted_markets, campaign_channels) were being discarded in production
 * with no error at all. `brand_name` and `category` had already been eaten
 * the same way.
 *
 * RUNS WITHOUT A DATABASE. CI has no Supabase credentials, so the source of
 * truth here is the COMMITTED snapshot src/db/missionsColumns.json, which is
 * regenerated from information_schema by `node scripts/dump-missions-schema.js`.
 * The contract is:
 *
 *   a migration adds a column
 *     -> the author regenerates the snapshot (or CI's live check flags it)
 *     -> the new column is in neither CLIENT_PATCHABLE nor SERVER_OWNED
 *     -> THIS TEST FAILS until it is deliberately classified
 *
 * The one thing a snapshot cannot catch on its own is a migration applied to
 * the DB without the snapshot being regenerated. `dump-missions-schema.js
 * --check` covers that and is meant to run in a credentialed job (nightly /
 * deploy), not on every PR. The live-drift test at the bottom of this file
 * does the same thing and self-skips when credentials are absent.
 */

const {
  ALLOWED_COLUMNS,
  SERVER_OWNED_COLUMNS,
  CLIENT_PATCHABLE_COLUMNS,
  SCHEMA_SNAPSHOT,
  sanitizeMissionPatch,
  sanitizeClientMissionPatch,
} = require('../src/db/missionSchema');

const snapshot = SCHEMA_SNAPSHOT.columns;

describe('missions schema snapshot — every column is classified', () => {
  test('THE DRIFT GUARD: no column is in neither the allowlist nor the denylist', () => {
    const unclassified = snapshot.filter(
      (c) => !CLIENT_PATCHABLE_COLUMNS.has(c) && !SERVER_OWNED_COLUMNS.has(c),
    );
    expect(unclassified).toEqual([]);
  });

  test('no column is in BOTH sets', () => {
    const both = snapshot.filter(
      (c) => CLIENT_PATCHABLE_COLUMNS.has(c) && SERVER_OWNED_COLUMNS.has(c),
    );
    expect(both).toEqual([]);
  });

  test('neither set names a column that does not exist on the table', () => {
    const ghosts = [...CLIENT_PATCHABLE_COLUMNS, ...SERVER_OWNED_COLUMNS]
      .filter((c) => !snapshot.includes(c));
    expect(ghosts).toEqual([]);
  });

  test('the two sets exactly partition the snapshot', () => {
    expect(CLIENT_PATCHABLE_COLUMNS.size + SERVER_OWNED_COLUMNS.size)
      .toBe(snapshot.length);
  });

  test('ALLOWED_COLUMNS is the whole snapshot (schema-existence guard, not a permission check)', () => {
    expect([...ALLOWED_COLUMNS].sort()).toEqual([...snapshot].sort());
  });

  test('snapshot metadata is self-consistent', () => {
    expect(SCHEMA_SNAPSHOT.column_count).toBe(snapshot.length);
    expect(new Set(snapshot).size).toBe(snapshot.length); // no duplicates
  });
});

describe('the 18 columns the hand-maintained list had lost', () => {
  // Verified against production information_schema. These are the exact
  // columns sanitizeMissionPatch was silently dropping.
  const RECOVERED = [
    'targeting_brief', 'brief_attachment', 'creative_analysis', 'desired_emotions',
    'key_message', 'tier', 'media_type', 'media_url', 'creative_metadata',
    'campaign_channels', 'wave_config', 'competitor_brands', 'brand_lift_template',
    'brand_lift_kpis', 'linked_mission_ids', 'wave_number', 'targeted_markets',
    'price_breakdown',
  ];

  test.each(RECOVERED)('%s survives sanitizeMissionPatch', (col) => {
    const { patch, rejected } = sanitizeMissionPatch({ [col]: 'x' });
    expect(rejected).toEqual([]);
    expect(patch).toHaveProperty(col);
  });

  test('the three columns POST /api/missions writes today are no longer dropped', () => {
    const { patch, rejected } = sanitizeMissionPatch({
      price_breakdown:   { total_usd: 600 },
      targeted_markets:  ['US', 'UK'],
      campaign_channels: ['meta'],
    });
    expect(rejected).toEqual([]);
    expect(Object.keys(patch).sort())
      .toEqual(['campaign_channels', 'price_breakdown', 'targeted_markets']);
  });
});

describe('server-owned columns are never client-patchable', () => {
  // Named individually rather than looped, so that moving any one of these
  // into CLIENT_PATCHABLE_COLUMNS fails a test that says why it matters.
  const MONEY_AND_STATE = [
    'status',                  // status='paid' is a free mission
    'user_id',                 // mission theft
    'id',
    'total_price_usd',
    'base_cost_usd',
    'targeting_surcharge_usd',
    'extra_questions_cost_usd',
    'price_estimated',
    'price_breakdown',
    'discount_usd',
    'promo_code',
    'paid_at',
    'paid_amount_cents',
    'partial_refund_amount_cents',
    'partial_refund_id',
    'ai_spend_ceiling_usd',    // the 30% margin cap
    'ai_spend_usd_actual',
    'chat_quota_limit',
    'target_qualified_count',
    'delivered_respondent_count',
    'delivery_status',
    'latest_payment_intent_id',
    'checkout_session_id',
    'payment_method',
    'insights',                // fabricated research
    'analysis',
    'executive_summary',
    'linked_mission_ids',      // IDOR primitive
  ];

  test.each(MONEY_AND_STATE)('%s is server-owned', (col) => {
    expect(SERVER_OWNED_COLUMNS.has(col)).toBe(true);
    expect(CLIENT_PATCHABLE_COLUMNS.has(col)).toBe(false);
  });

  test.each(MONEY_AND_STATE)('sanitizeClientMissionPatch refuses %s', (col) => {
    const { patch, denied } = sanitizeClientMissionPatch({ [col]: 'attacker-value' });
    expect(patch).toEqual({});
    expect(denied).toEqual([col]);
  });

  test('a mixed patch keeps the safe keys and denies the rest', () => {
    const { patch, denied, rejected } = sanitizeClientMissionPatch({
      title:           'Legit edit',
      brief:           'Legit brief',
      status:          'paid',
      total_price_usd: 0,
      not_a_column:    true,
    });
    expect(patch).toEqual({ title: 'Legit edit', brief: 'Legit brief' });
    expect(denied.sort()).toEqual(['status', 'total_price_usd']);
    expect(rejected).toEqual(['not_a_column']);
  });

  test('denied (real column, server-owned) is distinguished from rejected (not a column)', () => {
    const { denied, rejected } = sanitizeClientMissionPatch({ status: 'paid', bogus_col: 1 });
    expect(denied).toEqual(['status']);
    expect(rejected).toEqual(['bogus_col']);
  });
});

describe('client-patchable columns the setup flow depends on', () => {
  // These are survey STIMULUS, not VETT billing — the price of the
  // customer's own product in a Van Westendorp study. Nothing in
  // pricingEngine.js reads them. Guarded so a future "deny anything with
  // price in the name" sweep does not break the pricing methodology.
  const RESEARCH_NOT_BILLING = [
    'pricing_expected_min', 'pricing_expected_max', 'pricing_model',
    'pricing_currency', 'pricing_methodology', 'concept_price_usd',
  ];

  test.each(RESEARCH_NOT_BILLING)('%s is client-patchable (research input, not billing)', (col) => {
    expect(CLIENT_PATCHABLE_COLUMNS.has(col)).toBe(true);
  });

  test('campaign_channel (singular, setup) and campaign_channels (plural, pricing) differ', () => {
    expect(CLIENT_PATCHABLE_COLUMNS.has('campaign_channel')).toBe(true);
    expect(SERVER_OWNED_COLUMNS.has('campaign_channels')).toBe(true);
  });

  test('core setup fields the PATCH route re-prices on remain patchable', () => {
    for (const col of ['title', 'brief', 'goal_type', 'questions', 'targeting', 'respondent_count']) {
      expect(CLIENT_PATCHABLE_COLUMNS.has(col)).toBe(true);
    }
  });
});

describe('sanitizeMissionPatch still guards genuine drift', () => {
  test('the historical phantom columns are still rejected', () => {
    const { patch, rejected } = sanitizeMissionPatch({
      mission_statement:         'x',
      targeting_config:          {},
      stripe_payment_intent_id:  'pi_1',
      price:                     1,
      pricing_breakdown:         {},
      payment_status:            'paid',
      updated_at:                'now',
    });
    expect(patch).toEqual({});
    expect(rejected.sort()).toEqual([
      'mission_statement', 'payment_status', 'price', 'pricing_breakdown',
      'stripe_payment_intent_id', 'targeting_config', 'updated_at',
    ]);
  });

  test('trusted server writers can still write lifecycle and money columns', () => {
    // updateMission is shared with runMission / webhooks / payments. If
    // ALLOWED_COLUMNS were narrowed to the client-patchable set, every one
    // of these writers would break.
    const { patch, rejected } = sanitizeMissionPatch({
      status: 'completed', paid_at: 'now', total_price_usd: 600,
      insights: {}, heartbeat_at: 'now',
    });
    expect(rejected).toEqual([]);
    expect(Object.keys(patch)).toHaveLength(5);
  });
});

describe('updateMission strict mode turns the silent drop into a hard error', () => {
  const { updateMission } = require('../src/db/missionSchema');

  // Minimal supabase stub — the call must never reach it in the strict case.
  function stubClient() {
    const calls = [];
    const chain = {
      update(patch) { calls.push(patch); return chain; },
      eq() { return chain; },
      select() { return chain; },
      then(res) { return Promise.resolve({ data: [{ id: 'm1' }], error: null }).then(res); },
    };
    return { calls, from: () => chain };
  }

  test('default (warn) behaviour is unchanged: unknown key dropped, write proceeds', async () => {
    const db = stubClient();
    const { rejected } = await updateMission(db, 'm1', { title: 'ok', not_a_column: 1 }, {
      caller: 'test',
    });
    expect(rejected).toEqual(['not_a_column']);
    expect(db.calls).toEqual([{ title: 'ok' }]);
  });

  test('strict:true throws instead of silently dropping', async () => {
    const db = stubClient();
    await expect(
      updateMission(db, 'm1', { title: 'ok', not_a_column: 1 }, { caller: 'test', strict: true }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_MISSION_COLUMN', rejected: ['not_a_column'] });
    expect(db.calls).toEqual([]); // nothing was written
  });

  test('strict:true is a no-op when every key is a real column', async () => {
    const db = stubClient();
    const { rejected } = await updateMission(db, 'm1', { title: 'ok', price_breakdown: {} }, {
      caller: 'test', strict: true,
    });
    expect(rejected).toEqual([]);
    expect(db.calls).toEqual([{ title: 'ok', price_breakdown: {} }]);
  });
});

// ── Live-schema drift (opt-in; skipped in CI) ─────────────────────────────
// The snapshot test above cannot see a migration applied to the DB but not
// committed. This closes that gap.
//
// Gated on an EXPLICIT flag rather than on the presence of SUPABASE_URL,
// because test/setupEnv.js unconditionally fills in dummy Supabase creds so
// that modules which read them at load time do not throw. Sniffing for
// credentials therefore always "finds" them and the test would try to reach
// https://example.supabase.co and fail in CI. Run it deliberately:
//
//   VETT_LIVE_SCHEMA_CHECK=1 npx jest test/mission_schema_snapshot.test.js
//
const describeLive = process.env.VETT_LIVE_SCHEMA_CHECK === '1' ? describe : describe.skip;

describeLive('live schema matches the committed snapshot', () => {
  test('no columns added or dropped since the snapshot was generated', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase.from('missions').select('*').limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return; // nothing to compare against

    const live = Object.keys(data[0]).sort();
    const added = live.filter((c) => !snapshot.includes(c));
    const removed = [...snapshot].filter((c) => !live.includes(c));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  }, 30000);
});
