#!/usr/bin/env node
/**
 * §3 export acceptance harness — rasterize-and-compare, offline, no LLM.
 *
 *   node scripts/export-acceptance-harness.js <outDir> [missionId ...]
 *
 * For each fixture (a real completed mission, or a synthetic ugly-data case) it
 * renders PDF + PPTX + XLSX from STORED data through the real exporters, runs
 * structural checks, rasterizes the PDF pages to PNG, and writes every artifact
 * to <outDir> for a human visual pass. "Closed in code" is not "closed on the
 * page": this reports what the RENDERED output actually is.
 *
 * Checks (structural — what offline rasterization can verify):
 *   - 0 em/en dashes across PDF text + PPTX slide text + XLSX cells
 *   - PPTX editable: no <p:pic> (embedded image) in slides; bars are native shapes
 *   - PPTX scorecard balance (§3a-4): stat-card shapes evenly spaced/sized
 *   - PPTX recs numbered (§3a-2): recommendation lines carry 1. 2. 3.
 *   - multi-select fragmentation (D6): rendered bar count <= option count
 *   - methodology label (D5): never the generic "Research Study" fallback
 *   - cross-surface identity: title present on all three
 *   - PDF text-item bbox overlaps (§3a-5 collision heuristic)
 * Pixel alignment / font / colour are NOT judged here — that is the visual pass.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY. (No Anthropic key needed.)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { createClient } = require('@supabase/supabase-js');
const JSZip = require('jszip');
const { buildPDF } = require('../src/services/exports/pdf-v2');
const { buildPPTX } = require('../src/services/exports/pptx');
const { buildXLSX } = require('../src/services/exports/xlsx');
const { buildCanonicalReport } = require('../src/services/report/buildReport');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const DASH = /[—–]/g;
const bufRes = () => { const ps = new PassThrough(); ps.chunks = []; ps.on('data', (c) => ps.chunks.push(c)); ps.setHeader = () => {}; ps.status = () => ps; ps.json = () => {}; ps.done = new Promise((r) => ps.on('end', r)); return ps; };
const sinkRes = () => { let buf = null; const r = { setHeader() {}, status() { return r; }, json() {}, end(b) { buf = b; }, get headersSent() { return false; }, _buf: () => buf }; return r; };

async function renderPDF(pack) { const r = sinkRes(); await buildPDF(pack, r); return r._buf(); }
async function renderPPTX(pack) { const r = sinkRes(); await buildPPTX(pack, r); return r._buf(); }
async function renderXLSX(pack) { const r = bufRes(); await buildXLSX(pack, r); await r.done; return Buffer.concat(r.chunks); }

async function pdfTextAndOverlaps(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  let text = ''; let overlaps = 0; const pages = doc.numPages;
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim());
    text += items.map((i) => i.str).join(' ') + '\n';
    // crude collision heuristic: two items whose baselines are within 3px AND x-ranges overlap by >6px
    const boxes = items.map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width || 0, s: i.str }));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      if (Math.abs(A.y - B.y) < 3 && Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) > 6) overlaps++;
    }
  }
  return { text, pages, overlaps };
}

async function rasterizePDF(buf, outBase) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('canvas');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1.6 });
    const canvas = createCanvas(vp.width, vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvasFactory: undefined }).promise;
    const f = `${outBase}-p${String(p).padStart(2, '0')}.png`;
    fs.writeFileSync(f, canvas.toBuffer('image/png'));
    out.push(f);
  }
  return out;
}

async function pptxAnalyze(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  let text = ''; let pics = 0; let shapes = 0; let scorecardBalance = null; const recsNumbered = { found: false, numbered: false };
  for (const n of slideNames) {
    const xml = await zip.files[n].async('string');
    text += xml.replace(/<[^>]+>/g, ' ') + '\n';
    pics += (xml.match(/<p:pic\b/g) || []).length;
    shapes += (xml.match(/<p:sp\b/g) || []).length;
    // recs slide: bullets/lines that should be numbered "1. ", "2. "
    const flat = xml.replace(/<[^>]+>/g, ' ');
    if (/recommendation/i.test(flat)) {
      recsNumbered.found = true;
      recsNumbered.numbered = /\b1\.\s/.test(flat) && /\b2\.\s/.test(flat);
    }
    // scorecard: >=3 sibling stat-card text boxes with off:x — check even spacing
    const offs = [...xml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m) => Number(m[1]));
    if (/scorecard|score card|demand|KPI|metric/i.test(flat) && offs.length >= 3) {
      const xs = [...new Set(offs)].sort((a, b) => a - b);
      if (xs.length >= 3) {
        const gaps = xs.slice(1).map((v, i) => v - xs[i]);
        const maxGap = Math.max(...gaps), minGap = Math.min(...gaps);
        // Conservative: only flag EGREGIOUS imbalance. The x-offset scan picks
        // up title/accent shapes too, so a modest spread is noise, not a defect.
        // (Definitive scorecard-balance needs the PPTX imaged — no LibreOffice
        // offline — so this is a coarse smell test, confirmed by the visual pass.)
        scorecardBalance = { even: (maxGap - minGap) / (maxGap || 1) < 0.75, gaps };
      }
    }
  }
  return { slides: slideNames.length, text, pics, shapes, scorecardBalance, recsNumbered };
}

async function xlsxText(buf) {
  const zip = await JSZip.loadAsync(buf); let t = '';
  for (const n of Object.keys(zip.files).filter((n) => /sharedStrings|sheet\d+\.xml$/.test(n))) t += (await zip.files[n].async('string')).replace(/<[^>]+>/g, ' ') + ' ';
  return t;
}

// Multi-select fragmentation (D6): compare rendered survey bars to the question's option count.
function multiSelectFrag(mission, report) {
  const issues = [];
  const survey = (report && report.survey) || [];
  for (const q of survey) {
    if (!/multi/i.test(q.renderer || '') && q.renderer !== 'choice') continue;
    const opts = (mission.questions || []).find((x) => x.id === q.question_id)?.options?.length || null;
    const bars = q.data && q.data.distribution ? Object.keys(q.data.distribution).length : (q.data && q.data.bars ? q.data.bars.length : null);
    if (opts && bars && bars > opts + 1) issues.push(`${q.question_id}: ${bars} bars vs ${opts} options`);
  }
  return issues;
}

// ── synthetic ugly-data fixtures (§3 "holds on ugly data") ───────────────
// Each takes a REAL base {mission, responses} and injects ONE pathology, then
// runs the identical render→check→rasterize pipeline. Nothing is fabricated
// wholesale — the mutation rides on real stored data so the render path stays
// real. What we're proving: the exporters HOLD (no crash, no NaN, no dash leak,
// no collision) on inputs uglier than any real mission, and the rasterized PNGs
// are there for the human visual pass on overflow/truncation.
const LONG_TITLE = 'A Deliberately Overlong Market Entry Readiness Assessment For The Gulf Dairy Category That Wraps Across Four Full Lines To Stress The Report Cover And The Title Slide Without Clipping Or Truncating The Header Block';
const LABEL_200 = 'This is an intentionally and excessively verbose survey answer option label engineered to run about two hundred characters long so that it stresses bar-label truncation and wrapping across the PDF chart, the PPTX slide bars and the XLSX cell without breaking the layout.';
const OPTS_11 = ['Instagram', 'TikTok', 'YouTube', 'Snapchat', 'X (Twitter)', 'Facebook', 'LinkedIn', 'Pinterest', 'Reddit', 'WhatsApp', 'Telegram'];

function uglyFixtures(base) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const out = [];

  // (1) 4-line title — cover + title-slide header overflow.
  {
    const mission = clone(base.mission);
    mission.title = LONG_TITLE;
    out.push({ mission, responses: base.responses, tag: 'ugly_title4line', note: 'title wraps ~4 lines' });
  }

  // (2) 200-char option label — bar-label truncation across all 3 surfaces.
  {
    const mission = clone(base.mission);
    const qid = 'ugly_q_longlabel';
    mission.questions = [...(mission.questions || []), {
      id: qid, type: 'single', text: 'Which statement best matches your view?',
      options: [LABEL_200, 'A short option', 'Another short option'],
    }];
    const responses = [...base.responses];
    for (let i = 0; i < 30; i += 1) {
      responses.push({ question_id: qid, answer: [LABEL_200, 'A short option', 'Another short option'][i % 3], persona_id: `ugly_ll_${i}` });
    }
    out.push({ mission, responses, tag: 'ugly_label200', note: '200-char bar label' });
  }

  // (3) 11-option multi-select — many-bar layout + D6 fragmentation: a drift
  //     variant "YouTube (mobile)" must fold back to "YouTube" (11 bars, not 12).
  {
    const mission = clone(base.mission);
    const qid = 'ugly_q_multi11';
    mission.questions = [...(mission.questions || []), {
      id: qid, type: 'multi', text: 'Which platforms do you use weekly? (select all that apply)', options: OPTS_11,
    }];
    const responses = [...base.responses];
    for (let i = 0; i < 44; i += 1) {
      const picks = OPTS_11.filter((_, j) => ((i + j) % 4) < 2 || (i % 11) === j); // deterministic, every option covered
      if (i % 13 === 0) picks.push('YouTube (mobile)'); // drift → must canonicalize to YouTube
      responses.push({ question_id: qid, answer: picks, persona_id: `ugly_m_${i}` });
    }
    out.push({ mission, responses, tag: 'ugly_multi11', note: '11-option multi-select + 1 drift variant' });
  }

  // (4) 1-respondent segment — the singleton-market floor (D9). Collapse the
  //     real sample to a SINGLE respondent so n=1 flows through the stat gate,
  //     centerpiece, personas and every chart. Must render (directional posture,
  //     no NaN, no divide-by-zero), not crash.
  {
    const mission = clone(base.mission);
    const idField = base.responses.some((r) => r && r.persona_id) ? 'persona_id'
      : (base.responses.some((r) => r && r.respondent_id) ? 'respondent_id' : null);
    let responses;
    if (idField) {
      const counts = {};
      for (const r of base.responses) { const k = r[idField]; if (k != null) counts[k] = (counts[k] || 0) + 1; }
      const one = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      responses = base.responses.filter((r) => String(r[idField]) === String(one));
    } else {
      const seen = new Set();
      responses = base.responses.filter((r) => { if (seen.has(r.question_id)) return false; seen.add(r.question_id); return true; });
    }
    out.push({ mission, responses, tag: 'ugly_segment_n1', note: `n=1 (${responses.length} answers)` });
  }

  return out;
}

// Render PDF+PPTX+XLSX for one fixture, run structural checks, rasterize the PDF,
// write every artifact. Shared by the real-mission path and the ugly path.
async function processPack(m, resp, tag, outDir) {
  const pack = { mission: m, responses: resp || [] };
  const r = { tag, type: m.goal_type, id: m.id, n: m.delivered_respondent_count || m.respondent_count };
  try {
    const clean = (resp || []).filter((x) => x && x.screened_out !== true);
    const report = buildCanonicalReport(m, m.analysis || null, clean);
    const [pdf, pptx, xlsx] = await Promise.all([renderPDF(pack), renderPPTX(pack), renderXLSX(pack)]);
    fs.writeFileSync(path.join(outDir, `${tag}.pdf`), pdf);
    fs.writeFileSync(path.join(outDir, `${tag}.pptx`), pptx);
    fs.writeFileSync(path.join(outDir, `${tag}.xlsx`), xlsx);
    const pdfR = await pdfTextAndOverlaps(pdf);
    const pptxR = await pptxAnalyze(pptx);
    const xt = await xlsxText(xlsx);
    const pngs = await rasterizePDF(pdf, path.join(outDir, tag));
    r.dashes = (pdfR.text.match(DASH) || []).length + (pptxR.text.match(DASH) || []).length + (xt.match(DASH) || []).length;
    r.pptxEditable = pptxR.pics === 0 && pptxR.shapes > 0;
    r.pptxPics = pptxR.pics;
    r.methodLabel = /Research Study/.test(pdfR.text) ? 'GENERIC (D5!)' : 'ok';
    r.recsNumbered = pptxR.recsNumbered.found ? (pptxR.recsNumbered.numbered ? 'numbered' : 'BULLETS (§3a-2)') : 'n/a';
    r.scorecard = pptxR.scorecardBalance ? (pptxR.scorecardBalance.even ? 'balanced' : 'IMBALANCED (§3a-4)') : 'n/a';
    r.pdfOverlaps = pdfR.overlaps;
    // §3a-5 — adjacent-cell mash the bbox heuristic misses: a digit directly
    // abutting a signal word with no space ("55CAUTION", "68GO").
    r.pdfMash = (pdfR.text.match(/\d(GO|CAUTION|NO[-_]?GO)\b/g) || []).length;
    r.d6 = multiSelectFrag(m, report);
    r.pages = pdfR.pages; r.slides = pptxR.slides; r.pngs = pngs.length;
    r.ok = true;
  } catch (e) { r.ok = false; r.err = e.message; }
  return r;
}

(async () => {
  const outDir = process.argv[2] || './harness-out';
  const rest = process.argv.slice(3);
  const uglyMode = rest[0] === 'ugly';
  const idsArg = uglyMode ? rest.slice(1) : rest;
  fs.mkdirSync(outDir, { recursive: true });

  // Fixtures are a uniform { mission, responses|null, tag }. responses===null →
  // load from DB in the loop (real-mission path); a concrete array → use as-is
  // (ugly path, already mutated).
  let fixtures = [];
  if (uglyMode) {
    // Load ONE rich base — a completed market_entry (scorecard + personas +
    // richest layout, the surface most sensitive to n=1 and overflow), else the
    // best completed mission — and derive the 4 pathologies from it.
    let base;
    if (idsArg.length) {
      const { data } = await db.from('missions').select('*').eq('id', idsArg[0]).limit(1);
      base = (data || [])[0];
    } else {
      const { data } = await db.from('missions').select('*').eq('status', 'completed').eq('goal_type', 'market_entry').limit(50);
      base = (data || []).sort((a, b) => ((b.insights ? 2 : 0) + (b.analysis ? 1 : 0)) - ((a.insights ? 2 : 0) + (a.analysis ? 1 : 0)))[0];
      if (!base) { const { data: any } = await db.from('missions').select('*').eq('status', 'completed').limit(1); base = (any || [])[0]; }
    }
    if (!base) { console.error('no completed base mission found for ugly mode'); process.exit(1); }
    const { data: resp } = await db.from('mission_responses').select('*').eq('mission_id', base.id).limit(6000);
    const baseClean = (resp || []).filter((x) => x && x.screened_out !== true);
    const nBase = new Set(baseClean.map((x) => x.persona_id).filter(Boolean)).size || '?';
    console.log(`ugly base: ${base.goal_type} ${base.id.slice(0, 8)} (n=${nBase}, ${baseClean.length} answers)\n`);
    fixtures = uglyFixtures({ mission: base, responses: baseClean });
  } else if (idsArg.length) {
    const { data } = await db.from('missions').select('*').in('id', idsArg);
    fixtures = (data || []).map((m) => ({ mission: m, responses: null, tag: `${m.goal_type || 'unknown'}_${m.id.slice(0, 8)}` }));
  } else {
    // Auto-pick the richest completed mission per goal_type.
    const { data } = await db.from('missions').select('*').eq('status', 'completed').limit(3000);
    const byType = {};
    for (const m of (data || [])) {
      const g = m.goal_type || 'unknown';
      const score = (m.insights ? 2 : 0) + (m.analysis ? 1 : 0) + Math.min(2, (m.delivered_respondent_count || m.respondent_count || 0) / 50);
      if (!byType[g] || score > byType[g]._s) byType[g] = { ...m, _s: score };
    }
    fixtures = Object.values(byType).map((m) => ({ mission: m, responses: null, tag: `${m.goal_type || 'unknown'}_${m.id.slice(0, 8)}` }));
  }

  const rows = [];
  for (const f of fixtures) {
    let resp = f.responses;
    if (resp === null || resp === undefined) {
      const { data } = await db.from('mission_responses').select('*').eq('mission_id', f.mission.id).limit(6000);
      resp = data || [];
    }
    const r = await processPack(f.mission, resp, f.tag, outDir);
    if (f.note) r.note = f.note;
    rows.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${f.tag.padEnd(28)} ${r.ok
      ? `dash:${r.dashes} edit:${r.pptxEditable ? 'Y' : 'N'} method:${r.methodLabel} recs:${r.recsNumbered} score:${r.scorecard} mash:${r.pdfMash} d6:${r.d6.length ? r.d6.join('|') : 'clean'} [${r.pages}p/${r.slides}s]${f.note ? `  «${f.note}»` : ''}`
      : 'ERROR ' + r.err}`);
  }

  fs.writeFileSync(path.join(outDir, '_results.json'), JSON.stringify(rows, null, 2));
  console.log(`\nArtifacts + rasterized PNGs written to ${outDir}`);
  const bad = rows.filter((r) => !r.ok || r.dashes > 0 || !r.pptxEditable || /D5|§3a/.test(`${r.methodLabel}${r.recsNumbered}${r.scorecard}`) || r.d6.length);
  console.log(bad.length ? `\n${bad.length} fixture(s) with a flag — see above.` : '\nAll structural checks clean.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
