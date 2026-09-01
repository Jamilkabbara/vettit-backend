/**
 * VETT — PDF export entry point.
 * Pass 25 Phase 0: drop-in replacement for ../pdf.js (pdfkit-based).
 * Pass 48 Phase 3: REBUILT on the CanonicalReport. The general_research and
 * brand_lift body templates now render the SAME report the web results page
 * renders (buildCanonicalReport → buildRenderModel), in the uniform section
 * order shared by every export format:
 *   header → exec summary → headline metrics → centerpiece (brand-lift
 *   exposed-vs-control funnel) → key findings → THE FULL SURVEY (every
 *   question by its renderer with the CORRECT scale — kills the "7/5"/"0/5"
 *   bug) → data-quality notes (canonical, cleaned) → methodology disclaimer.
 * Both templates render identical structure from the same `report` model.
 *
 * The creative_attention template is a separate goal type (its own analysis
 * shape `ca`) and is out of Pass-48 scope; its view-model fields are preserved.
 *
 * Public API:
 *   buildPDF(pack, res)
 *     pack — { mission, responses, insights, ... } from loadMissionForExport
 *     res  — Express response (we set headers + write the PDF buffer)
 */

const fs   = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const logger = require('../../../utils/logger');
const { renderPdfFromHtml, getFontFaceCss } = require('./engine');
const { getReportMetadata } = require('../reportMetadata');
const { buildCanonicalReport } = require('../../report/buildReport');
const { buildRenderModel } = require('../../report/reportRenderModel');
const { sanitizeDashesDeep, sanitizeDashesString } = require('../../../utils/textSanitize');
const { METHODOLOGY_URL } = require('../shared');
// PR 3 — shared hotspot normalizer. attention_hotspots is EITHER an array of
// legacy strings (every mission run before the spatial schema shipped) or an
// array of {label,x,y,w,h,weight} objects. One helper, three surfaces.
const { normalizeHotspots } = require('../../../utils/creativeHotspots');

/* ─── Template + CSS loading (once per process) ─────────────────────────── */

const TEMPLATE_DIR = path.join(__dirname, 'templates');

let _baseCss        = null;
let _baseTemplate   = null;
let _bodyTemplates  = {};
let _helpersReg     = false;

function loadBaseCss() {
  if (_baseCss) return _baseCss;
  _baseCss = fs.readFileSync(path.join(TEMPLATE_DIR, '_base.css'), 'utf8');
  return _baseCss;
}

function loadBaseTemplate() {
  if (_baseTemplate) return _baseTemplate;
  const src = fs.readFileSync(path.join(TEMPLATE_DIR, '_base.hbs'), 'utf8');
  _baseTemplate = Handlebars.compile(src, { noEscape: false });
  return _baseTemplate;
}

function loadBodyPartial(name) {
  // Pass 48 — the shared canonical body partial. general_research and
  // brand_lift both {{> canonicalBody}}, so their structure is guaranteed
  // identical (the Pass-48 requirement that exports be structurally the
  // same across methodologies). Registered once; safe to re-register.
  if (!_bodyTemplates.__canonical) {
    _bodyTemplates.__canonical = fs.readFileSync(path.join(TEMPLATE_DIR, '_canonical_body.hbs'), 'utf8');
  }
  Handlebars.registerPartial('canonicalBody', _bodyTemplates.__canonical);

  // Pass 44 P0 — ALWAYS re-register the 'body' partial, even on cache
  // hit. The old early-return skipped registerPartial, so whichever
  // template was exported FIRST after process boot stayed registered
  // as 'body' for every subsequent PDF regardless of mission type.
  if (_bodyTemplates[name]) {
    Handlebars.registerPartial('body', _bodyTemplates[name]);
    return _bodyTemplates[name];
  }
  const file = path.join(TEMPLATE_DIR, `${name}.hbs`);
  if (!fs.existsSync(file)) {
    throw new Error(`PDF body template not found: ${name}.hbs`);
  }
  const src = fs.readFileSync(file, 'utf8');
  _bodyTemplates[name] = src;          // store raw — will register as partial
  Handlebars.registerPartial('body', src);
  return src;
}

function registerHelpers() {
  if (_helpersReg) return;

  Handlebars.registerHelper('ifEq', function (a, b, options) {
    return a === b ? options.fn(this) : options.inverse(this);
  });

  // KPI trend → CSS class (creative_attention + key findings)
  Handlebars.registerHelper('kpiClass', function (trend) {
    if (trend === 'negative') return 'kpi-value--negative';
    if (trend === 'neutral')  return 'kpi-value--neutral';
    return '';
  });

  Handlebars.registerHelper('add', function (a, b) {
    return Number(a) + Number(b);
  });

  // Pass 48 — render-model survey body dispatch by `body.kind`.
  Handlebars.registerHelper('ifKind', function (kind, expected, options) {
    return kind === expected ? options.fn(this) : options.inverse(this);
  });

  _helpersReg = true;
}

/* ─── View-model construction ───────────────────────────────────────────── */

/** Clean responses the same way results.js /report does (mirror the web). */
function cleanResponses(responses) {
  const all = responses || [];
  const clean = all.filter((r) =>
    r && r.screened_out !== true && !(r.persona_profile && r.persona_profile.screened_out === true));
  return clean.length > 0 ? clean : all;
}

/**
 * Convert the canonical report into a flat, render-ready view model for the
 * Handlebars templates. The template gets data already shaped for it.
 */
function buildViewModel(pack) {
  const { mission } = pack;

  // STEP 1 — canonical report once, then the shared render model.
  const report = buildCanonicalReport(mission, mission.analysis || null, cleanResponses(pack.responses));
  const model = buildRenderModel(report);

  const meta = getReportMetadata(mission);

  const caSanitized = sanitizeDashesDeep(mission?.creative_analysis || null);

  return {
    // Cover (shared by every body template via _base.hbs)
    mission: {
      id:                mission.id,
      title:             model.header.title,
      brief:             model.header.brief,
      respondent_count:  mission.respondent_count || '—',
    },
    // Pass 48 canonical render model — the single source the body renders.
    report: model,
    hasHeadline:        !!model.headline,
    hasCenterpiece:     !!model.centerpiece,
    hasKeyFindings:     model.keyFindings.length > 0,
    hasDataQualityNotes: model.dataQualityNotes.length > 0,
    // §2.4 — directional banner when the sample can't support an authoritative read.
    isDirectional:      !!(model.gate && model.gate.posture === 'directional' && model.gate.note),

    missionCompletedLabel: meta.mission_completed_label,
    reportGeneratedLabel:  meta.report_generated_label,
    generatedDate:      meta.report_generated_label,

    // Creative-attention body (separate goal type, out of Pass-48 scope).
    // D7 — deep-scrub the raw LLM creative_analysis so the CA-specific PDF
    // sections inherit the no-dash rule (the canonical `model` already is).
    ca: caSanitized,
    // PR 2 enrichment — precomputed rows the CA template can't derive in
    // Handlebars: effectiveness sub-scores joined with their weights, and the
    // full 24-emotion profile (frame-averaged) chunked into 3-pair table rows.
    // PR 3 adds the chart geometry (decay curve, attention split, emotion
    // bars) and the normalized hotspot boxes. Both read the DASH-SANITIZED
    // analysis so the CA extras inherit the no-dash rule the same way `ca` does.
    ...buildCaViewExtras(caSanitized),
    media_url: mission?.media_url || null,
    brand_name: sanitizeDashesString(mission?.brand_name) || null,

    // Public methodology page, linked from the cover footer and beside the
    // simulation-honesty disclaimer (never in place of it) so a reader who
    // receives this PDF second-hand can audit how the figures were produced.
    methodologyUrl:     METHODOLOGY_URL,

    fontFaceCss:        getFontFaceCss(),
    baseCss:            loadBaseCss(),
  };
}

/* ─── PR 2 — CA view-model extras (effectiveness rows + emotion grid) ───── */

const CA_EMPTY_EXTRAS = {
  caComponents: null, caEmotions: [], caEmotionRows: [], caMultiFrame: false,
  caEmotionBarCols: [], caSplit: null, caDecay: null, caFrames: [],
  caHotspotMaps: [], caHotspotMapsTotal: 0, caHotspotMapsCapped: false,
};

function buildCaViewExtras(ca) {
  if (!ca || typeof ca !== 'object') {
    return { ...CA_EMPTY_EXTRAS };
  }
  // Effectiveness components joined with weights, heaviest weight first.
  const comp = (ca.creative_effectiveness && ca.creative_effectiveness.components) || null;
  const weights = (ca.creative_effectiveness && ca.creative_effectiveness.weights) || {};
  const caComponents = comp
    ? Object.entries(comp)
      .map(([key, score]) => ({
        label: String(key).replace(/_/g, ' '),
        score: Math.round(Number(score) || 0),
        weight: weights[key] != null ? `${Math.round(Number(weights[key]) * 100)}%` : '',
        _w: Number(weights[key]) || 0,
      }))
      .sort((a, b) => b._w - a._w)
    : null;

  // Full emotion profile: average each emotion across frames, sort desc.
  const frames = Array.isArray(ca.frame_analyses) ? ca.frame_analyses : [];
  const sums = new Map();
  for (const f of frames) {
    const emo = (f && f.emotions) || {};
    for (const [name, v] of Object.entries(emo)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const cur = sums.get(name) || { total: 0, count: 0 };
      cur.total += n; cur.count += 1;
      sums.set(name, cur);
    }
  }
  const caEmotions = [...sums.entries()]
    .map(([name, { total, count }]) => {
      const score = Math.round(total / Math.max(1, count));
      return { name: name.replace(/_/g, ' '), score, hot: score > 50 };
    })
    .sort((a, b) => b.score - a.score);
  // 3 name/score pairs per printed row keeps 24 emotions to 8 rows.
  const caEmotionRows = [];
  for (let i = 0; i < caEmotions.length; i += 3) caEmotionRows.push(caEmotions.slice(i, i + 3));

  // ── PR 3 — emotion BARS (the table alone hid the shape of the profile) ──
  // Two balanced columns of 12 so all 24 emotions stay on one printed page.
  const halfway = Math.ceil(caEmotions.length / 2);
  const caEmotionBarCols = caEmotions.length
    ? [caEmotions.slice(0, halfway), caEmotions.slice(halfway)].filter((c) => c.length)
    : [];

  return {
    caComponents, caEmotions, caEmotionRows, caMultiFrame: frames.length > 1,
    caEmotionBarCols,
    caSplit: buildCaSplit(ca.attention),
    caDecay: buildCaDecay(ca.attention),
    ...buildCaFrames(frames),
  };
}

/* ─── PR 3 — attention split (active / passive / non-attention) ─────────── */

const CA_SPLIT_PARTS = [
  { key: 'active_attention_pct',  label: 'Active attention',  color: 'var(--lime)',   note: 'eyes on, focused' },
  { key: 'passive_attention_pct', label: 'Passive attention', color: 'var(--purple)', note: 'aware, not watching' },
  { key: 'non_attention_pct',     label: 'Non-attention',     color: 'var(--text3)',  note: 'scrolled past' },
];

function buildCaSplit(attention) {
  if (!attention || typeof attention !== 'object') return null;
  const parts = CA_SPLIT_PARTS.map((p) => {
    const n = Number(attention[p.key]);
    return { ...p, pct: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 };
  });
  const total = parts.reduce((a, b) => a + b.pct, 0);
  if (total <= 0) return null;
  // Widths are normalized so the stacked bar always spans the full track even
  // when the model's three percentages sum to 98 or 101; the LABELS keep the
  // model's own numbers.
  return {
    parts: parts.map((p) => ({ ...p, width: Math.round((p.pct / total) * 1000) / 10 })),
    total,
    sumsTo100: total === 100,
  };
}

/* ─── PR 3 — attention decay curve as inline SVG ─────────────────────────── */
// The PDF engine is Chromium, so an inline SVG is a first-class citizen: it
// prints as vector (crisp at any zoom) and needs no chart library. Geometry is
// precomputed here because Handlebars cannot do arithmetic.

const DECAY_VB_W = 640;
const DECAY_VB_H = 190;
const DECAY_X0 = 46;          // left gutter for the y-axis labels
const DECAY_X1 = 626;
const DECAY_Y_TOP = 14;       // y for 100%
const DECAY_Y_BASE = 152;     // y for 0%

function buildCaDecay(attention) {
  const raw = attention && Array.isArray(attention.attention_decay_curve)
    ? attention.attention_decay_curve : [];
  const pts = raw
    .map((p) => ({ second: Number(p && p.second), active: Number(p && p.active_pct) }))
    .filter((p) => Number.isFinite(p.second) && Number.isFinite(p.active))
    .map((p) => ({ second: p.second, active: Math.min(100, Math.max(0, p.active)) }))
    .sort((a, b) => a.second - b.second);
  if (!pts.length) return null;

  const maxSecond = Math.max(...pts.map((p) => p.second));
  const span = maxSecond > 0 ? maxSecond : 1;
  const xFor = (sec) => (pts.length === 1
    ? DECAY_X0 + (DECAY_X1 - DECAY_X0) / 2
    : DECAY_X0 + ((sec / span) * (DECAY_X1 - DECAY_X0)));
  const yFor = (v) => DECAY_Y_BASE - (v / 100) * (DECAY_Y_BASE - DECAY_Y_TOP);
  const r1 = (n) => Math.round(n * 10) / 10;

  const dots = pts.map((p, i) => ({
    cx: r1(xFor(p.second)), cy: r1(yFor(p.active)),
    second: p.second, active: Math.round(p.active),
    first: i === 0, last: i === pts.length - 1,
  }));

  // Label only the first, middle and last tick so x-axis labels can never
  // collide on a 30-frame video curve.
  const tickIdx = new Set([0, pts.length - 1]);
  if (pts.length >= 5) tickIdx.add(Math.floor((pts.length - 1) / 2));
  const xTicks = [...tickIdx].sort((a, b) => a - b).map((i) => ({
    x: dots[i].cx, y: DECAY_Y_BASE + 20, label: `${pts[i].second}s`,
    anchor: i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle'),
  }));

  const gridLines = [0, 25, 50, 75, 100].map((v) => ({
    y: r1(yFor(v)), labelX: DECAY_X0 - 8, labelY: r1(yFor(v)) + 4,
    label: `${v}%`, major: v === 0 || v === 100,
  }));

  const polyline = dots.map((d) => `${d.cx},${d.cy}`).join(' ');
  const area = `${DECAY_X0},${DECAY_Y_BASE} ${polyline} ${r1(dots[dots.length - 1].cx)},${DECAY_Y_BASE}`;

  const first = pts[0].active;
  const last = pts[pts.length - 1].active;
  // A single-reading (static image) curve is drawn as ONE column instead of a
  // lonely dot, so the static case still reads as a chart.
  const staticCol = pts.length === 1
    ? { x: r1(dots[0].cx - 30), y: dots[0].cy, w: 60, h: r1(DECAY_Y_BASE - dots[0].cy) }
    : null;
  return {
    dots, xTicks, gridLines, polyline, area, staticCol,
    isStatic: pts.length === 1,
    vbW: DECAY_VB_W, vbH: DECAY_VB_H,
    x0: DECAY_X0, x1: DECAY_X1, yBase: DECAY_Y_BASE,
    firstPct: Math.round(first),
    lastPct: Math.round(last),
    dropPct: Math.round(first - last),
    maxSecond,
  };
}

/* ─── PR 3 — per-frame hotspots (BOTH schema shapes) ─────────────────────── */
// Legacy missions store attention_hotspots as STRINGS; missions run after the
// spatial-schema ship store {label,x,y,w,h,weight}. normalizeHotspots collapses
// both to one shape, and `hasSpatial` decides whether this frame can be drawn
// as a hotspot MAP or must render as the text list.

const CA_HOTSPOT_MAP_CAP = 6;     // boxes drawn per map
const CA_HOTSPOT_FRAME_CAP = 6;   // frames given a map before the section caps

function buildCaFrames(frames) {
  const caFrames = frames.map((f, i) => {
    const hotspots = normalizeHotspots(f && f.attention_hotspots)
      .map((h, hi) => ({ ...h, rank: hi + 1 }));
    const spatial = hotspots.filter((h) => h.spatial).slice(0, CA_HOTSPOT_MAP_CAP);
    return {
      index: i + 1,
      timestamp: f && f.timestamp,
      engagement_score: f && f.engagement_score,
      brief_description: f && f.brief_description,
      message_clarity: f && f.message_clarity,
      audience_resonance: f && f.audience_resonance,
      hotspots,
      hotspotLabels: hotspots.map((h) => h.label),
      hasSpatial: spatial.length > 0,
      spatialHotspots: spatial,
    };
  });
  // A 30-frame video would otherwise print 30 maps; the PDF shows the first
  // few and the frame-by-frame section still lists every frame's hotspots.
  const mapped = caFrames.filter((f) => f.hasSpatial);
  return {
    caFrames,
    caHotspotMaps: mapped.slice(0, CA_HOTSPOT_FRAME_CAP),
    caHotspotMapsTotal: mapped.length,
    caHotspotMapsCapped: mapped.length > CA_HOTSPOT_FRAME_CAP,
  };
}

/* ─── Mission-type → body-template selection ────────────────────────────── */

function bodyTemplateForMission(mission) {
  // Creative Attention keeps its bespoke body (frame-by-frame, emotion, etc.).
  if (mission?.goal_type === 'creative_attention') return 'creative_attention';
  // Pass 48 — brand_lift and EVERY other methodology render the SAME canonical
  // report body. brand_lift uses its own partial only so the centerpiece funnel
  // is framed under a brand-lift heading; structurally it is identical.
  if (mission?.goal_type === 'brand_lift') return 'brand_lift_study';
  return 'general_research';
}

/* ─── Public entry: buildPDF(pack, res) ─────────────────────────────────── */

async function buildPDF(pack, res) {
  registerHelpers();
  const viewModel    = buildViewModel(pack);
  const bodyTemplate = bodyTemplateForMission(pack.mission);
  loadBodyPartial(bodyTemplate);

  const baseTpl = loadBaseTemplate();
  const html = baseTpl(viewModel);

  let buf;
  try {
    buf = await renderPdfFromHtml(html);
  } catch (err) {
    logger.error?.('PDF render failed', { err: err.message, stack: err.stack });
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF render failed', detail: err.message });
    }
    return;
  }

  const safeName = (viewModel.mission.title || pack.mission.id)
    .toString()
    .slice(0, 40)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'report';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="vett-report-${safeName}.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

module.exports = { buildPDF };
