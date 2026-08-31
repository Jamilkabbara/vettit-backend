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
    ca: sanitizeDashesDeep(mission?.creative_analysis || null),
    // PR 2 enrichment — precomputed rows the CA template can't derive in
    // Handlebars: effectiveness sub-scores joined with their weights, and the
    // full 24-emotion profile (frame-averaged) chunked into 3-pair table rows.
    ...buildCaViewExtras(mission?.creative_analysis || null),
    media_url: mission?.media_url || null,
    brand_name: sanitizeDashesString(mission?.brand_name) || null,

    fontFaceCss:        getFontFaceCss(),
    baseCss:            loadBaseCss(),
  };
}

/* ─── PR 2 — CA view-model extras (effectiveness rows + emotion grid) ───── */

function buildCaViewExtras(ca) {
  if (!ca || typeof ca !== 'object') {
    return { caComponents: null, caEmotions: [], caEmotionRows: [], caMultiFrame: false };
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

  return { caComponents, caEmotions, caEmotionRows, caMultiFrame: frames.length > 1 };
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
