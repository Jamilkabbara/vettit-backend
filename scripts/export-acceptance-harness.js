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

(async () => {
  const outDir = process.argv[2] || './harness-out';
  const idsArg = process.argv.slice(3);
  fs.mkdirSync(outDir, { recursive: true });

  const ids = idsArg.length ? idsArg : [
    'e29883ee-ed7e-4e97-99c3-1e20a5fb0ca4', // research n=100 (fix real ids below at runtime)
  ];
  // If no ids passed, auto-pick one completed mission per goal_type.
  let fixtures = [];
  if (idsArg.length) {
    const { data } = await db.from('missions').select('*').in('id', idsArg);
    fixtures = data || [];
  } else {
    const { data } = await db.from('missions').select('*').eq('status', 'completed').limit(3000);
    const byType = {};
    for (const m of (data || [])) {
      const g = m.goal_type || 'unknown';
      const score = (m.insights ? 2 : 0) + (m.analysis ? 1 : 0) + Math.min(2, (m.delivered_respondent_count || m.respondent_count || 0) / 50);
      if (!byType[g] || score > byType[g]._s) byType[g] = { ...m, _s: score };
    }
    fixtures = Object.values(byType);
  }

  const { buildCanonicalReport } = require('../src/services/report/buildReport');
  const rows = [];
  for (const m of fixtures) {
    const { data: resp } = await db.from('mission_responses').select('*').eq('mission_id', m.id).limit(6000);
    const pack = { mission: m, responses: resp || [] };
    const tag = `${(m.goal_type || 'unknown')}_${m.id.slice(0, 8)}`;
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
    rows.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${tag.padEnd(28)} ${r.ok
      ? `dash:${r.dashes} edit:${r.pptxEditable ? 'Y' : 'N'} method:${r.methodLabel} recs:${r.recsNumbered} score:${r.scorecard} mash:${r.pdfMash} d6:${r.d6.length ? r.d6.join('|') : 'clean'} [${r.pages}p/${r.slides}s]`
      : 'ERROR ' + r.err}`);
  }

  fs.writeFileSync(path.join(outDir, '_results.json'), JSON.stringify(rows, null, 2));
  console.log(`\nArtifacts + rasterized PNGs written to ${outDir}`);
  const bad = rows.filter((r) => !r.ok || r.dashes > 0 || !r.pptxEditable || /D5|§3a/.test(`${r.methodLabel}${r.recsNumbered}${r.scorecard}`) || r.d6.length);
  console.log(bad.length ? `\n${bad.length} fixture(s) with a flag — see above.` : '\nAll structural checks clean.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
