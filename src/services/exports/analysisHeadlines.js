/**
 * Pass 47 Phase 4 — export-facing headline extractor.
 *
 * analysisHeadlines(analysis) flattens the Pass-46-Phase-3 deterministic
 * methodology analysis (missions.analysis) into an ordered array of
 * { label, value } strings — the KEY COMPUTED METRICS every export format
 * (PDF / PPTX / XLSX / JSON) must carry, so the research-grade centerpiece
 * numbers are present (not just generic per-question tables).
 *
 * Methodology-aware: the cases here MIRROR src/services/ai/insights.js
 * buildComputedSummary (same field paths per methodology) so the prose
 * narrator and the export headlines never disagree on which numbers matter.
 * The math is NOT recomputed — every value is read verbatim from the
 * already-computed `analysis` object.
 *
 * Fully null-safe and defensive: any missing/malformed field is skipped,
 * never throws, and null/unknown input returns []. Values are coerced to
 * display strings; percentages from the analysis modules are 0-100 numbers
 * already (round4), so we present them as-is with a trailing unit.
 *
 * Full chart-visual parity (redrawing the SVG centerpieces) is OUT OF SCOPE
 * for Pass 47 — deferred to Pass 48. This module guarantees the NUMBERS.
 */

/** Coerce a value to a trimmed display string, or null when not presentable. */
function str(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * A number formatted as a percent string ("80%", "66.7%"), or null.
 * The analysis modules carry 4-decimal round4 percentages; for display we
 * round to at most 1 decimal (66.6667 → 66.7) while keeping clean integers
 * integer (80 → "80%", not "80.0%").
 */
function pct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const n = Math.round(Number(v) * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/** Significance label from a brand-lift/two-proportion significance block. */
function sigLabel(sig) {
  if (!sig) return 'directional';
  if (sig.sig95) return 'significant at 95%';
  if (sig.sig90) return 'significant at 90%';
  return 'directional';
}

/**
 * @param {object|null} analysis  the deterministic methodology analysis
 *        (missions.analysis); top-level `methodology` selects the case.
 * @returns {Array<{label:string, value:string}>} ordered headline metrics.
 *          Empty array when there's nothing computable to surface.
 */
function analysisHeadlines(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const out = [];
  const push = (label, value) => {
    const v = str(value);
    if (v !== null && label) out.push({ label, value: v });
  };

  try {
    switch (analysis.methodology) {
      case 'pricing': {
        const opp = analysis.van_westendorp?.points?.opp;
        push('Optimal price (Van Westendorp OPP)', opp);
        const range = analysis.acceptable_range;
        if (range && range.low != null && range.high != null) {
          push('Acceptable price range', `${range.low}–${range.high}`);
        }
        // VW range corners (point of marginal cheapness / expensiveness).
        const pts = analysis.van_westendorp?.points || {};
        push('Point of marginal cheapness (PMC)', pts.pmc);
        push('Point of marginal expensiveness (PME)', pts.pme);
        push('Indifference price point (IPP)', pts.ipp);
        push('Gabor-Granger revenue-optimal price', analysis.gabor_granger?.optimal_price);
        if (analysis.wtp_ceiling?.mean != null) {
          push('WTP ceiling (mean)', analysis.wtp_ceiling.mean);
        }
        if (analysis.currency) push('Currency', analysis.currency);
        if (analysis.van_westendorp?.n != null) push('Van Westendorp base (n)', analysis.van_westendorp.n);
        break;
      }

      case 'satisfaction': {
        if (analysis.nps?.score != null) push('NPS', analysis.nps.score);
        push('CSAT (top-2-box)', pct(analysis.csat?.top2_pct));
        push('CES (top-2-box)', pct(analysis.ces?.top2_pct));
        if (analysis.retention?.stats?.mean != null) {
          push('Retention / likelihood-to-return (mean of 5)', analysis.retention.stats.mean);
        }
        // Top ranked issue, when present.
        const topIssue = analysis.issues?.ranked?.[0];
        if (topIssue) push(`Top issue: ${topIssue.option}`, pct(topIssue.pct_of_respondents));
        if (analysis.nps?.n != null) push('NPS base (n)', analysis.nps.n);
        break;
      }

      case 'brand_lift': {
        const ex = analysis.cells?.exposed?.n;
        const co = analysis.cells?.control?.n;
        if (ex != null) push('Exposed cell (n)', ex);
        if (co != null) push('Control cell (n)', co);
        // Each funnel stage with a computed lift → exposed% / control% / lift / sig.
        for (const f of analysis.funnel || []) {
          if (!f || f.lift_abs == null) continue;
          const stage = f.text || f.funnel_stage || f.question_id || 'Stage';
          if (f.type === 'proportion') {
            const exPct = f.exposed?.rate != null ? `${Math.round(f.exposed.rate * 100)}%` : '?';
            const coPct = f.control?.rate != null ? `${Math.round(f.control.rate * 100)}%` : '?';
            const liftPts = `${Math.round(f.lift_abs * 100)} pts`;
            push(stage, `exposed ${exPct} vs control ${coPct} (+${liftPts}, ${sigLabel(f.significance)})`);
          } else if (f.type === 'mean') {
            const exM = f.exposed?.mean != null ? f.exposed.mean : '?';
            const coM = f.control?.mean != null ? f.control.mean : '?';
            push(stage, `exposed ${exM} vs control ${coM} (+${f.lift_abs}, ${sigLabel(f.significance)})`);
          }
        }
        if (analysis.summary) {
          push('Funnel stages lifted', analysis.summary.stages_lifted);
          push('Stages significant at 95%', analysis.summary.stages_sig95);
        }
        break;
      }

      case 'roadmap': {
        // Top MaxDiff features by utility (already sorted utility desc).
        const feats = (analysis.maxdiff?.features || []).filter((f) => f && f.utility != null).slice(0, 5);
        for (const f of feats) {
          push(`MaxDiff: ${f.label || f.feature_id}`, `utility ${f.utility}`);
        }
        // Kano must-haves.
        const must = (analysis.kano?.features || [])
          .filter((f) => f && f.classification === 'must_be')
          .map((f) => f.label || f.feature_id);
        if (must.length) push('Kano must-haves', must.join(', '));
        if (analysis.maxdiff?.n != null) push('MaxDiff base (n)', analysis.maxdiff.n);
        break;
      }

      case 'naming': {
        // Candidates with win-rate (pairwise) or composite, ranked.
        const cands = (analysis.candidates || []).slice().sort((a, b) => {
          const aw = a.pairwise_win_rate?.pct ?? a.composite ?? -Infinity;
          const bw = b.pairwise_win_rate?.pct ?? b.composite ?? -Infinity;
          return bw - aw;
        });
        const winnerId = analysis.winner?.candidate_id;
        for (const c of cands) {
          const isWinner = c.candidate_id === winnerId ? ' (winner)' : '';
          if (c.pairwise_win_rate?.pct != null) {
            push(`${c.label || c.candidate_id}${isWinner}`, `${c.pairwise_win_rate.pct}% win rate`);
          } else if (c.composite != null) {
            push(`${c.label || c.candidate_id}${isWinner}`, `composite ${c.composite}`);
          }
        }
        break;
      }

      case 'compare': {
        const winnerId = analysis.overall_winner?.concept_id;
        for (const c of analysis.concepts || []) {
          if (!c) continue;
          const isWinner = c.concept_id === winnerId ? ' (winner)' : '';
          const share = c.final_choice_pct?.pct;
          if (share != null) {
            push(`${c.label || c.concept_id}${isWinner}`, `${share}% forced choice`);
          } else if (c.dimensions?.appeal?.mean != null) {
            push(`${c.label || c.concept_id}${isWinner}`, `appeal ${c.dimensions.appeal.mean}`);
          }
        }
        if (analysis.final_choice?.none) {
          push('None of these', pct(analysis.final_choice.none.pct));
        }
        break;
      }

      case 'competitor': {
        if (analysis.focal_brand) push('Focal brand', analysis.focal_brand);
        // Per-brand preference share.
        for (const b of analysis.brands || []) {
          if (!b || b.preference_pct == null) continue;
          push(`${b.label}${b.is_focal ? ' (focal)' : ''} — preference`, pct(b.preference_pct));
        }
        // Biggest gaps vs best competitor (gaps sorted ascending = worst first).
        for (const g of (analysis.gaps || []).slice(0, 3)) {
          if (!g) continue;
          push(`Gap on "${g.attribute}" vs ${g.best_competitor}`, `${g.gap} pts`);
        }
        break;
      }

      case 'churn': {
        // Ranked drivers (rankedMulti → { ranked:[{option,count,pct_of_respondents}] }).
        for (const d of (analysis.drivers?.ranked || []).slice(0, 5)) {
          if (!d) continue;
          push(`Churn driver: ${d.option}`, pct(d.pct_of_respondents));
        }
        if (analysis.winback?.winnable_pct != null) {
          push('Winnable (would return)', pct(analysis.winback.winnable_pct));
        }
        break;
      }

      case 'validate': {
        if (analysis.scores?.reaction?.mean != null) push('Concept reaction (mean of 10)', analysis.scores.reaction.mean);
        if (analysis.scores?.relevance?.mean != null) push('Relevance (mean of 7)', analysis.scores.relevance.mean);
        if (analysis.scores?.uniqueness?.mean != null) push('Uniqueness (mean of 7)', analysis.scores.uniqueness.mean);
        if (analysis.scores?.believability?.mean != null) push('Believability (mean of 7)', analysis.scores.believability.mean);
        push('Purchase intent (top-2-box)', pct(analysis.intent?.top2_pct));
        break;
      }

      case 'marketing': {
        const fn = analysis.funnel || {};
        if (fn.recall_aided?.correct_rate != null) push('Aided recall', `${Math.round(fn.recall_aided.correct_rate * 100)}%`);
        if (fn.attribution?.correct_rate != null) push('Correct brand attribution', `${Math.round(fn.attribution.correct_rate * 100)}%`);
        if (fn.likeability?.mean != null) push('Likeability (mean of 7)', fn.likeability.mean);
        if (fn.stopping_power?.mean != null) push('Stopping power (mean of 7)', fn.stopping_power.mean);
        if (fn.distinctiveness?.mean != null) push('Distinctiveness (mean of 7)', fn.distinctiveness.mean);
        if (fn.persuasion?.mean != null) push('Persuasion (mean of 7)', fn.persuasion.mean);
        if (fn.message_match?.rate != null) push('Message match', `${Math.round(fn.message_match.rate * 100)}%`);
        break;
      }

      case 'research': {
        // Generic per-question base sizes (no methodology centerpiece).
        for (const q of (analysis.per_question || []).slice(0, 12)) {
          if (!q) continue;
          const label = q.text ? `n — ${String(q.text).slice(0, 60)}` : `n — ${q.question_id}`;
          push(label, q.n);
        }
        break;
      }

      default:
        break;
    }
  } catch {
    // Fully defensive: a malformed analysis object must never break an export.
    return out;
  }

  return out;
}

/**
 * Brand-lift per-stage lift table — richer than the flat headlines, for the
 * XLSX "Key Results" sheet (and any format wanting a structured table).
 * Returns [] for non-brand_lift or when no stage has a computed lift.
 * Columns: stage | exposed | control | lift | significance | n (exposed/control).
 */
function brandLiftStageTable(analysis) {
  if (!analysis || analysis.methodology !== 'brand_lift') return [];
  const rows = [];
  for (const f of analysis.funnel || []) {
    if (!f || f.lift_abs == null) continue;
    const stage = f.text || f.funnel_stage || f.question_id || 'Stage';
    if (f.type === 'proportion') {
      rows.push({
        stage,
        exposed: f.exposed?.rate != null ? `${Math.round(f.exposed.rate * 100)}%` : '—',
        control: f.control?.rate != null ? `${Math.round(f.control.rate * 100)}%` : '—',
        lift: `+${Math.round(f.lift_abs * 100)} pts`,
        significance: sigLabel(f.significance),
        n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
      });
    } else if (f.type === 'mean') {
      rows.push({
        stage,
        exposed: f.exposed?.mean != null ? String(f.exposed.mean) : '—',
        control: f.control?.mean != null ? String(f.control.mean) : '—',
        lift: `+${f.lift_abs}`,
        significance: sigLabel(f.significance),
        n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
      });
    }
  }
  return rows;
}

module.exports = { analysisHeadlines, brandLiftStageTable };
