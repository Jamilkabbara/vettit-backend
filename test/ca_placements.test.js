/**
 * The Creative Attention placement list: closed, normed, and in agreement with
 * the database.
 *
 * Owner's rule: only the placements with real attention norms, no
 * channels_master. The list IS the synthesis prompt's norms table, rendered
 * from one module; these tests hold the list, the database CHECK constraint,
 * the public options endpoint and the benchmark arithmetic to each other.
 */
jest.mock('../src/db/supabase', () => ({ from: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const supabase = require('../src/db/supabase');
const {
  CA_PLACEMENTS, placementsForMedia, resolvePlacement, computePlacementBenchmark, publicPlacementList,
} = require('../src/services/creativeAttention/placements');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', 'pass-56', '01_creative_attention_targeting_columns.sql'), 'utf8');

describe('the list', () => {
  test('is exactly the placements that carry a published attention norm', () => {
    expect(CA_PLACEMENTS.map((p) => [p.label, p.normActiveSeconds])).toEqual([
      ['Instagram Feed', 1.2], ['TikTok Feed', 1.4], ['YouTube Pre-roll', 1.8], ['Pinterest', 1.5],
      ['Snapchat', 0.9], ['Meta Reels / Stories', 1.0], ['Programmatic Display', 0.4],
      ['OOH (digital billboard)', 0.8], ['CTV (15s)', 4.5], ['CTV (30s)', 8.0],
      ['TV (30s spot)', 12.0], ['Print (luxury magazine)', 2.5],
    ]);
  });

  test('each norm used for the benchmark is the figure the model is shown', () => {
    for (const p of CA_PLACEMENTS) {
      const shown = Number(/:\s+([\d.]+)s/.exec(p.promptLine)[1]);
      expect({ id: p.id, shown }).toEqual({ id: p.id, shown: p.normActiveSeconds });
    }
  });

  test('audio has no visual norm and is not selectable', () => {
    expect(CA_PLACEMENTS.some((p) => /audio|spotify|podcast/i.test(p.label))).toBe(false);
  });

  test('no channels_master channel is offered', () => {
    const names = CA_PLACEMENTS.map((p) => p.label.toLowerCase()).join('|');
    for (const channel of ['shahid', 'mbc', 'anghami', 'starzplay', 'vox', 'noon', 'carrefour', 'osn']) {
      expect(names).not.toContain(channel);
    }
  });

  test('formats: motion placements are video only, print is image only', () => {
    const img = placementsForMedia('image').map((p) => p.id);
    const vid = placementsForMedia('video').map((p) => p.id);
    for (const id of ['youtube_preroll', 'ctv_15s', 'ctv_30s', 'tv_30s']) {
      expect(img).not.toContain(id);
      expect(vid).toContain(id);
    }
    expect(img).toContain('print_luxury_magazine');
    expect(vid).not.toContain('print_luxury_magazine');
    expect(resolvePlacement('tv_30s', 'image')).toBeNull();
    expect(resolvePlacement('shahid', 'video')).toBeNull();
    expect(resolvePlacement('tiktok_feed', 'video').id).toBe('tiktok_feed');
  });
});

describe('agreement with the database constraint', () => {
  const checked = (() => {
    const m = /missions_ca_placement_known\s+CHECK \(ca_placement IS NULL OR ca_placement IN \(([\s\S]*?)\)\);/.exec(MIGRATION);
    return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : null;
  })();

  test('the migration CHECK lists exactly the ids the code accepts, in order', () => {
    expect(checked).toEqual(CA_PLACEMENTS.map((p) => p.id));
  });

  test('the migration refuses the columns on every other goal type', () => {
    expect(MIGRATION).toMatch(/goal_type = 'creative_attention'\s+OR \(ca_target_audience IS NULL AND ca_placement IS NULL AND ca_market IS NULL\)/);
  });

  test('the migration adds constraints VALID, never NOT VALID', () => {
    const executable = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(executable).not.toMatch(/NOT VALID/);
  });
});

describe('the benchmark', () => {
  const tiktok = resolvePlacement('tiktok_feed', 'video');

  test('is arithmetic on the prediction against the chosen norm', () => {
    expect(computePlacementBenchmark({ placement: tiktok, attention: { predicted_active_attention_seconds: 2.1 } }))
      .toEqual({ placement_id: 'tiktok_feed', placement_label: 'TikTok Feed', norm_active_seconds: 1.4, predicted_active_seconds: 2.1, delta_vs_norm_pct: 50 });
    expect(computePlacementBenchmark({ placement: tiktok, attention: { predicted_active_attention_seconds: 0.7 } }).delta_vs_norm_pct).toBe(-50);
  });

  test('withholds the comparison when there is no usable prediction, never guesses', () => {
    for (const attention of [undefined, {}, { predicted_active_attention_seconds: 0 }, { predicted_active_attention_seconds: 'n/a' }]) {
      expect(computePlacementBenchmark({ placement: tiktok, attention })).toEqual({
        placement_id: 'tiktok_feed', placement_label: 'TikTok Feed', norm_active_seconds: 1.4,
        predicted_active_seconds: null, delta_vs_norm_pct: null,
      });
    }
  });

  test('returns nothing without a placement', () => {
    expect(computePlacementBenchmark({ placement: null, attention: { predicted_active_attention_seconds: 2 } })).toBeNull();
  });

  test('cannot be influenced by a market passed alongside', () => {
    const a = computePlacementBenchmark({ placement: tiktok, attention: { predicted_active_attention_seconds: 1.9 } });
    const b = computePlacementBenchmark({ placement: tiktok, attention: { predicted_active_attention_seconds: 1.9 }, market: { code: 'SA' } });
    expect(b).toEqual(a);
  });
});

describe('GET /api/creative-attention/options', () => {
  const express = require('express');
  const router = require('../src/routes/creativeAttention');
  const app = express().use('/api/creative-attention', router);

  function marketsReturn(result) {
    supabase.from.mockImplementation(() => {
      const api = { select: () => api, order: async () => result };
      return api;
    });
  }

  async function get(p) {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      return { status: res.status, body: await res.json() };
    } finally { server.close(); }
  }

  test('serves the closed placement list and the markets list', async () => {
    marketsReturn({ data: [{ code: 'GCC', display_name: 'GCC', is_meta_market: true, display_order: 1 }, { code: 'SA', display_name: 'Saudi Arabia', is_meta_market: false, display_order: 2 }], error: null });
    const r = await get('/api/creative-attention/options');
    expect(r.status).toBe(200);
    expect(r.body.placements).toEqual(publicPlacementList());
    expect(r.body.placements).toHaveLength(12);
    expect(r.body.markets).toEqual([
      { code: 'GCC', name: 'GCC', is_meta_market: true },
      { code: 'SA', name: 'Saudi Arabia', is_meta_market: false },
    ]);
  });

  test('says markets are unavailable rather than returning an empty list that looks real', async () => {
    marketsReturn({ data: null, error: { message: 'boom' } });
    const r = await get('/api/creative-attention/options');
    expect(r.status).toBe(503);
    expect(r.body.markets).toBeNull();
    expect(r.body.placements).toHaveLength(12);
  });
});
