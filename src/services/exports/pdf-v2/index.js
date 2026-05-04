/**
 * VETT — PDF export entry point.
 * Pass 25 Phase 0: drop-in replacement for ../pdf.js (pdfkit-based).
 *
 * Public API:
 *   buildPDF(pack, res)
 *     pack — { mission, insights, aggregatedByQuestion } from loadMissionForExport
 *     res  — Express response (we set headers + write the PDF buffer)
 *
 * The signature matches the old pdfkit version so the route handler swaps
 * one line.
 */

const fs   = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const logger = require('../../../utils/logger');
const { renderPdfFromHtml, getFontFaceCss } = require('./engine');
const { resolveQuestionInsight } = require('../screenerInsights');
const { buildIntegrityWarnings } = require('../integrity');
const { getReportMetadata } = require('../reportMetadata');

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
  if (_bodyTemplates[name]) return _bodyTemplates[name];
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

  // Equality helper for {{#ifEq this.type "rating"}}
  Handlebars.registerHelper('ifEq', function (a, b, options) {
    return a === b ? options.fn(this) : options.inverse(this);
  });

  // "single" mission types — anything that's not rating/multi/text gets bars
  Handlebars.registerHelper('ifSingle', function (type, options) {
    const isSingle = type !== 'rating' && type !== 'multi' && type !== 'text';
    return isSingle ? options.fn(this) : options.inverse(this);
  });

  // KPI trend → CSS class
  Handlebars.registerHelper('kpiClass', function (trend) {
    if (trend === 'negative') return 'kpi-value--negative';
    if (trend === 'neutral')  return 'kpi-value--neutral';
    return '';  // positive / undefined → default (lime)
  });

  // Question eyebrow text: "02 · QUESTION 1"
  Handlebars.registerHelper('questionEyebrow', function (idx) {
    const sectionNum = String(idx + 2).padStart(2, '0');
    const qNum       = idx + 1;
    return new Handlebars.SafeString(`${sectionNum} · Question ${qNum}`);
  });

  _helpersReg = true;
}

/* ─── View-model construction ───────────────────────────────────────────── */

/**
 * Convert raw mission data into a flat, render-ready view model.
 * The template gets the data already shaped for it — no logic in the template.
 */
function buildViewModel(pack) {
  const { mission, insights, aggregatedByQuestion } = pack;

  // KPIs
  const kpis = Array.isArray(insights?.kpis) ? insights.kpis.slice(0, 3) : [];

  // Per-question data
  const questions = (mission.questions || []).map(q => {
    const agg = aggregatedByQuestion[q.id] || {};

    let ratingRows = [];
    let distRows   = [];
    let verbatims  = [];

    if (q.type === 'rating') {
      const dist = agg.distribution || {};
      const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
      for (let r = 5; r >= 1; r--) {
        const c = dist[r] || 0;
        ratingRows.push({
          rating: r,
          count:  c,
          pct:    Math.round((c / total) * 100),
        });
      }
    } else if (q.type === 'multi') {
      const dist = agg.distribution || {};
      const nResp = agg.n_respondents || agg.n || 1;
      distRows = Object.entries(dist)
        .sort((a, b) => b[1] - a[1])
        .map(([opt, count]) => ({
          label: String(opt),
          count,
          pct: Math.round((count / nResp) * 100),
        }));
    } else if (q.type === 'text') {
      verbatims = (agg.verbatims || []).slice(0, 5).map(v => String(v));
    } else {
      // single / opinion / fallback
      // Pass 26 Minor 5 — for screener questions, render every schema option
      // (including ones at 0 count) so the reader sees the screener's full
      // option set, not just the qualifying choice. For non-screener single-
      // choice questions, keep the prior behaviour (only show options that
      // received at least one response, sorted descending).
      const dist = agg.distribution || {};
      const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
      const isScreener = q.isScreening === true || q.type === 'screening';
      if (isScreener && Array.isArray(q.options) && q.options.length > 0) {
        const qualifying = q.qualifyingAnswer;
        distRows = q.options.map(opt => {
          const c = Number(dist[opt] || 0);
          return {
            label: String(opt) + (qualifying === opt ? '  (qualifying)' : ''),
            count: c,
            pct: Math.round((c / total) * 100),
          };
        });
      } else {
        distRows = Object.entries(dist)
          .sort((a, b) => b[1] - a[1])
          .map(([opt, count]) => ({
            label: String(opt),
            count,
            pct: Math.round((count / total) * 100),
          }));
      }
    }

    // Per-question insight pullquote
    // Pass 25 Phase 0.1 Bug B — screener questions where 100% qualified get a
    // sample-composition note instead of the (often tautological) AI insight.
    const piList = insights?.per_question_insights || [];
    const rawInsight = piList.find(pi => pi.question_id === q.id) || null;
    const resolvedInsight = resolveQuestionInsight(
      q,
      agg,
      rawInsight ? { headline: rawInsight.headline, body: rawInsight.body || '' } : null,
      pack.sampleMetrics,
    );

    return {
      id:           q.id,
      text:         q.text,
      type:         q.type,
      aggregation:  agg,
      ratingRows,
      distRows,
      verbatims,
      insight: resolvedInsight ? {
        headline: resolvedInsight.headline,
        body:     resolvedInsight.body || '',
      } : null,
    };
  });

  // Pass 25 Phase 0.1 Bug H + A — integrity warnings rendered as appendix page
  const integrityWarnings = buildIntegrityWarnings(mission, aggregatedByQuestion);

  // Pass 25 Phase 0.1 Minor 1 — distinct mission_completed vs report_generated
  const meta = getReportMetadata(mission);

  return {
    mission: {
      id:                mission.id,
      title:             mission.title || 'Research Report',
      brief:             mission.brief || mission.mission_statement || '',
      respondent_count:  mission.respondent_count || '—',
    },
    insights: insights || {},
    kpis,
    hasKpis:            kpis.length > 0,
    questions,
    hasRecommendations: Array.isArray(insights?.recommendations) && insights.recommendations.length > 0,
    hasFollowUps:       Array.isArray(insights?.follow_ups)      && insights.follow_ups.length > 0,
    integrityWarnings,
    hasIntegrityWarnings: integrityWarnings.length > 0,
    hasTrailingContent: (Array.isArray(insights?.recommendations) && insights.recommendations.length > 0)
                        || (Array.isArray(insights?.follow_ups) && insights.follow_ups.length > 0)
                        || integrityWarnings.length > 0,
    missionCompletedLabel: meta.mission_completed_label,
    reportGeneratedLabel:  meta.report_generated_label,
    generatedDate:      meta.report_generated_label,
    // Pass 25 Phase 1G — surface the pre-aggregated brand-lift payload
    // (score / funnel / channels / geography / competitors / waves /
    // recommendations) so the brand_lift_study.hbs body can render it.
    blr: mission?.brand_lift_results || null,
    fontFaceCss:        getFontFaceCss(),
    baseCss:            loadBaseCss(),
  };
}

/* ─── Mission-type → body-template selection ────────────────────────────── */

function bodyTemplateForMission(mission) {
  // Pass 25 Phase 1G — brand_lift missions use a brand-lift-specific
  // body partial that includes the score dial, funnel, channel
  // performance, geo, competitor comparison, wave comparison, and AI
  // recs sections.
  if (mission?.goal_type === 'brand_lift') return 'brand_lift_study';
  // Phase 0: every general-research mission uses general_research.hbs.
  // Phase 0.5 will route Creative Attention missions to creative_attention.hbs.
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

  const safeName = (pack.mission.title || pack.mission.id)
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
