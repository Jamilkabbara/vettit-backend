/* WO §3.3 — market_entry: per-market demand index, signal, ranked barriers. */
const { computeMarketEntry } = require('../src/services/analysis/marketEntry');

const QUESTIONS = [
  { id: 'q_screen', kind: 'screener', type: 'single', text: 'In category in your market?' },
  { id: 'q_appeal', kind: 'appeal', type: 'rating', text: 'How appealing (1-7)?' },
  { id: 'q_intent', kind: 'intent', type: 'single', text: 'Would you buy?' },
  { id: 'q_wtp', kind: 'wtp', type: 'rating', text: 'What would you pay?' },
  { id: 'q_barrier', kind: 'barrier', type: 'multi', text: 'What would stop you?' },
  { id: 'q_comp', kind: 'competitive', type: 'multi', text: 'What do you use locally?' },
];

function buildMarket(market, count, { appeal, intent, wtp, barrier, comp }) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const persona_id = `${market}_${i}`;
    const pp = { market };
    rows.push({ persona_id, persona_profile: pp, question_id: 'q_appeal', answer: appeal });
    rows.push({ persona_id, persona_profile: pp, question_id: 'q_intent', answer: intent });
    rows.push({ persona_id, persona_profile: pp, question_id: 'q_wtp', answer: wtp });
    rows.push({ persona_id, persona_profile: pp, question_id: 'q_barrier', answer: barrier });
    rows.push({ persona_id, persona_profile: pp, question_id: 'q_comp', answer: comp });
  }
  return rows;
}

describe('computeMarketEntry', () => {
  test('two markets: strong demand → go, weak → caution/no_go; recommended = best', () => {
    const rows = [
      ...buildMarket('UAE', 35, { appeal: 7, intent: 'Definitely would buy', wtp: 120, barrier: 'Awareness', comp: 'Talabat' }),
      ...buildMarket('KSA', 35, { appeal: 2, intent: 'Would not buy', wtp: 40, barrier: 'Regulatory', comp: 'HungerStation' }),
    ];
    const res = computeMarketEntry(rows, QUESTIONS, { goal_type: 'market_entry', targeted_markets: ['UAE', 'KSA'] });
    expect(res.methodology).toBe('market_entry');
    expect(res.n).toBe(70);
    expect(res.markets.length).toBe(2);

    const uae = res.markets.find((m) => m.market === 'UAE');
    const ksa = res.markets.find((m) => m.market === 'KSA');
    expect(uae.purchase_intent_pct).toBe(100);
    expect(uae.appeal_mean).toBeCloseTo(7, 1);
    expect(uae.signal).toBe('go');
    expect(uae.demand_index).toBeGreaterThan(ksa.demand_index);
    expect(['caution', 'no_go']).toContain(ksa.signal);
    expect(uae.directional).toBe(false); // n=35 ≥ 30

    expect(res.recommended_market).toBe('UAE');
    expect(res.best_demand_index).toBe(uae.demand_index);
    expect(uae.competitors[0].label).toBe('Talabat');
    expect(uae.barriers[0].label).toBe('Awareness');
  });

  test('untagged responses collapse to the declared target market', () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push({ persona_id: `p${i}`, question_id: 'q_intent', answer: 'Probably would buy' });
      rows.push({ persona_id: `p${i}`, question_id: 'q_appeal', answer: 5 });
    }
    const res = computeMarketEntry(rows, QUESTIONS, { goal_type: 'market_entry', targeted_markets: ['Egypt'] });
    expect(res.markets.length).toBe(1);
    expect(res.markets[0].market).toBe('Egypt');
    expect(res.markets[0].directional).toBe(true); // n=5 < 30
  });

  test('never throws on empty input', () => {
    const res = computeMarketEntry([], QUESTIONS, {});
    expect(res.methodology).toBe('market_entry');
    expect(Array.isArray(res.markets)).toBe(true);
  });
});
