/**
 * Placement and market appear in the PDF, PPTX and XLSX - and nowhere for
 * analyses that predate them.
 *
 * Owner's rule: placement and market must appear on the results page and in
 * all three exports. Each export is rendered here from the same fixture
 * analysis and its actual output inspected: the XLSX workbook's cells, the
 * PPTX slide XML, and the HTML the PDF is printed from. (The PDF engine drives
 * a headless browser; that step is stubbed, and the rendered pages were
 * checked by eye when this shipped.)
 *
 * The PPTX colour assertion exists because the first version of the slide
 * named a palette colour that does not exist. hex(undefined) is an empty
 * string, PowerPoint falls back to black, and the placement sentence and every
 * market note rendered black on the near-black background. No text check
 * would ever notice; only looking did. This test would.
 */
jest.mock('../src/db/supabase', () => ({ from: jest.fn(), storage: { from: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockPdf = { html: null };
jest.mock('../src/services/exports/pdf-v2/engine', () => ({
  renderPdfFromHtml: jest.fn(async (html) => { mockPdf.html = html; return Buffer.from('%PDF-1.4 stub'); }),
  getFontFaceCss: () => '',
}));

const { PassThrough } = require('stream');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { caTargetingView } = require('../src/services/creativeAttention/targetingView');
const { buildPDF } = require('../src/services/exports/pdf-v2');
const { buildPPTX } = require('../src/services/exports/pptx');
const { buildCreativeAttentionXLSX } = require('../src/services/exports/xlsx_creative_attention');

function analysis(extra = {}) {
  return {
    schema_version: 'v2',
    total_frames: 1, is_video: false, generated_at: '2026-09-13T00:00:00.000Z',
    frame_analyses: [{ timestamp: 0, emotions: { joy: 40, trust: 30 }, attention_hotspots: [], message_clarity: 60, audience_resonance: 55, engagement_score: 62, brief_description: 'A bottle on a table.' }],
    summary: { overall_engagement_score: 62, attention_arc: 'Holds early.', strengths: ['Clear pack shot.'], weaknesses: ['Small logo.'], recommendations: ['Enlarge the logo.'], vs_benchmark: '', best_platform_fit: [], emotion_peaks: [] },
    attention: { predicted_active_attention_seconds: 1.2, predicted_passive_attention_seconds: 0.8, active_attention_pct: 50, passive_attention_pct: 30, non_attention_pct: 20, distinctive_brand_asset_score: 45, dba_read_seconds: 1.4, attention_decay_curve: [{ second: 0, active_pct: 50 }] },
    creative_effectiveness: { score: 58, band: 'average', weights: { attention: 0.25 }, components: { attention: 60, emotion_intensity: 55, brand_clarity: 50, audience_resonance: 52, platform_fit: 70 }, band_explanation: 'Attention leads.' },
    ...extra,
  };
}
const TARGETING = {
  placement_benchmark: { placement_id: 'tiktok_feed', placement_label: 'TikTok Feed', norm_active_seconds: 1.4, predicted_active_seconds: 1.2, delta_vs_norm_pct: -14 },
  market: { code: 'SA', name: 'Saudi Arabia' },
  market_context: {
    cultural_fit: ['The domestic setting reads as family-first.'],
    localisation_risks: ['Arabic supers are expected on the end frame.'],
    placement_notes: ['Short vertical video is the default viewing mode.'],
  },
};
function mission(ca) {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001', user_id: '11111111-1111-4111-8111-111111111111',
    goal_type: 'creative_attention', title: 'Creative Attention: Orchard', brand_name: 'Orchard',
    status: 'completed', completed_at: '2026-09-13T00:00:00.000Z', created_at: '2026-09-13T00:00:00.000Z',
    respondent_count: 10, media_type: 'image', creative_analysis: ca,
  };
}
function sink() {
  const chunks = []; const r = new PassThrough();
  r.on('data', (c) => chunks.push(c));
  r.setHeader = () => {}; r.status = () => r; r.set = () => r; r.type = () => r; r.attachment = () => r;
  r.send = (b) => { chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); r.end(); };
  r.done = new Promise((res) => r.on('finish', res));
  r.buf = () => Buffer.concat(chunks);
  return r;
}

describe('the shared wording', () => {
  test('above, below, in line, and no prediction', () => {
    const v = (d, p) => caTargetingView({ placement_benchmark: { ...TARGETING.placement_benchmark, delta_vs_norm_pct: d, predicted_active_seconds: p } }).placement;
    expect(v(-14, 1.2).sentence).toBe('Predicted 1.2s of active attention on TikTok Feed, 14% below the published norm of 1.4s.');
    expect(v(50, 2.1).sentence).toBe('Predicted 2.1s of active attention on TikTok Feed, 50% above the published norm of 1.4s.');
    expect(v(0, 1.4).sentence).toBe('Predicted 1.4s of active attention on TikTok Feed, in line with the published norm of 1.4s.');
    expect(v(null, null).sentence).toBe('The published attention norm for TikTok Feed is 1.4s of active attention. This run returned no attention prediction to compare against it.');
    expect([v(-14, 1.2).deltaLabel, v(50, 2.1).deltaLabel, v(0, 1.4).deltaLabel, v(null, null).deltaLabel]).toEqual(['-14%', '+50%', 'In line', 'Not compared']);
  });

  test('older analyses produce nothing', () => {
    expect(caTargetingView(analysis())).toBeNull();
    expect(caTargetingView(null)).toBeNull();
  });

  test('a market whose notes failed still shows the market', () => {
    const v = caTargetingView({ market: TARGETING.market });
    expect(v.market).toEqual({ code: 'SA', name: 'Saudi Arabia' });
    expect(v.marketNotesUnavailable).toBe(true);
  });

  test('no em or en dash anywhere in the wording', () => {
    expect(JSON.stringify(caTargetingView(analysis(TARGETING)))).not.toMatch(/[–—]/);
  });
});

describe('XLSX', () => {
  async function workbook(ca) {
    const res = sink();
    await buildCreativeAttentionXLSX({ mission: mission(ca), responses: [] }, res);
    await Promise.race([res.done, new Promise((r) => setTimeout(r, 2000))]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buf());
    return wb;
  }

  test('adds a Placement and Market sheet and a cover line', async () => {
    const wb = await workbook(analysis(TARGETING));
    const sheet = wb.getWorksheet('Placement and Market');
    expect(sheet).toBeTruthy();
    const values = [];
    sheet.eachRow((row) => row.eachCell((c) => values.push(String(c.value))));
    expect(values).toEqual(expect.arrayContaining([
      'TikTok Feed', '1.4', '1.2', '-14', 'Saudi Arabia',
      'Predicted 1.2s of active attention on TikTok Feed, 14% below the published norm of 1.4s.',
      'Arabic supers are expected on the end frame.',
    ]));
    expect(String(wb.getWorksheet('Cover').getCell('A26').value)).toBe('Placement: TikTok Feed  |  Market: Saudi Arabia');
  });

  test('an older analysis gets neither', async () => {
    const wb = await workbook(analysis());
    expect(wb.getWorksheet('Placement and Market')).toBeUndefined();
    expect(wb.getWorksheet('Cover').getCell('A26').value).toBeNull();
  });
});

describe('PPTX', () => {
  async function slides(ca) {
    const res = sink();
    await buildPPTX({ mission: mission(ca), responses: [] }, res);
    const z = await JSZip.loadAsync(res.buf());
    const files = Object.keys(z.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    return Promise.all(files.map(async (f) => ({ f, xml: await z.file(f).async('string') })));
  }
  const text = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');

  test('adds the placement slide and the market notes slide', async () => {
    const all = await slides(analysis(TARGETING));
    const placement = all.find((s) => /PLACEMENT AND MARKET/.test(text(s.xml)));
    const notes = all.find((s) => /MARKET NOTES: SAUDI ARABIA/.test(text(s.xml)));
    expect(placement).toBeTruthy();
    expect(notes).toBeTruthy();
    expect(text(placement.xml)).toContain('TikTok Feed');
    expect(text(placement.xml)).toContain('Predicted 1.2s of active attention on TikTok Feed, 14% below the published norm of 1.4s.');
    expect(text(notes.xml)).toContain('Arabic supers are expected on the end frame.');
  });

  test('every text run on those slides has an explicit, readable colour', async () => {
    const all = await slides(analysis(TARGETING));
    const targeted = all.filter((s) => /PLACEMENT AND MARKET|MARKET NOTES/.test(text(s.xml)));
    expect(targeted).toHaveLength(2);
    for (const s of targeted) {
      // each run: <a:r><a:rPr ...>...</a:rPr><a:t>text</a:t></a:r>
      const runs = [...s.xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map((m) => m[1]).filter((r) => /<a:t>[^<]+<\/a:t>/.test(r));
      expect(runs.length).toBeGreaterThan(5);
      for (const r of runs) {
        const t = /<a:t>([^<]*)<\/a:t>/.exec(r)[1];
        const colour = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(r);
        expect({ text: t, hasColour: !!colour }).toEqual({ text: t, hasColour: true });
        const [R, G, B] = [0, 2, 4].map((i) => parseInt(colour[1].slice(i, i + 2), 16));
        const luminance = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        // background is #0B0C15; anything this dark is unreadable on it
        expect({ text: t, readable: luminance > 60 }).toEqual({ text: t, readable: true });
      }
    }
  });

  test('an older analysis gets neither slide', async () => {
    const all = await slides(analysis());
    expect(all.some((s) => /PLACEMENT AND MARKET|MARKET NOTES/.test(text(s.xml)))).toBe(false);
  });
});

describe('PDF', () => {
  async function html(ca) {
    mockPdf.html = null;
    const res = sink();
    await buildPDF({ mission: mission(ca), responses: [] }, res);
    return mockPdf.html;
  }

  test('prints the placement and market section', async () => {
    const h = await html(analysis(TARGETING));
    expect(h).toContain('· Placement and market');
    expect(h).toContain('TikTok Feed');
    expect(h).toContain('-14%');
    expect(h).toContain('Predicted 1.2s of active attention on TikTok Feed, 14% below the published norm of 1.4s.');
    expect(h).toContain('· Market: Saudi Arabia');
    expect(h).toContain('Qualitative only. The market does not change any score, prediction or benchmark in this report.');
    expect(h).toContain('Arabic supers are expected on the end frame.');
  });

  test('an older analysis prints no such section', async () => {
    const h = await html(analysis());
    expect(h).not.toContain('Placement and market');
    expect(h).not.toContain('Qualitative only. The market');
  });
});
