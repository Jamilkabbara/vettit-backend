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

/**
 * A number rounded for DISPLAY to at most `dp` decimals, trailing zeros
 * stripped, as a string: 2.6667 → "2.67", 234.9999 → "235", 0.1778 → "0.18".
 * Returns null for non-finite input so push() skips it. This rounds the
 * DISPLAYED value only — the stored analysis object keeps full precision for
 * downstream stats. Default 2 dp suits means / scores / money / utilities;
 * pass dp=1 for percentages embedded in a string.
 */
function num(v, dp = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const f = 10 ** dp;
  return String(Math.round(Number(v) * f) / f);
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
        push('Optimal price (Van Westendorp OPP)', num(opp));
        const range = analysis.acceptable_range;
        if (range && range.low != null && range.high != null) {
          push('Acceptable price range', `${num(range.low)}–${num(range.high)}`);
        }
        // VW range corners (point of marginal cheapness / expensiveness).
        const pts = analysis.van_westendorp?.points || {};
        push('Point of marginal cheapness (PMC)', num(pts.pmc));
        push('Point of marginal expensiveness (PME)', num(pts.pme));
        push('Indifference price point (IPP)', num(pts.ipp));
        push('Gabor-Granger revenue-optimal price', num(analysis.gabor_granger?.optimal_price));
        if (analysis.wtp_ceiling?.mean != null) {
          push('WTP ceiling (mean)', num(analysis.wtp_ceiling.mean));
        }
        if (analysis.currency) push('Currency', analysis.currency);
        if (analysis.van_westendorp?.n != null) push('Van Westendorp base (n)', analysis.van_westendorp.n);
        break;
      }

      case 'satisfaction': {
        if (analysis.nps?.score != null) push('NPS', num(analysis.nps.score));
        push('CSAT (top-2-box)', pct(analysis.csat?.top2_pct));
        push('CES (top-2-box)', pct(analysis.ces?.top2_pct));
        if (analysis.retention?.stats?.mean != null) {
          push('Retention / likelihood-to-return (mean of 5)', num(analysis.retention.stats.mean));
        }
        // Top ranked issue, when present.
        const topIssue = analysis.issues?.ranked?.[0];
        if (topIssue) push(`Top issue: ${topIssue.option}`, pct(topIssue.pct_of_respondents));
        if (analysis.nps?.n != null) push('NPS base (n)', analysis.nps.n);
        break;
      }

      case 'brand_lift': {
        // Lead with the LIFTED funnel stages — that's the actual finding.
        // (Pass 48: cell base sizes used to lead, so the headline read
        // "Exposed cell (n)=3" instead of the lift the study measured.)
        for (const f of analysis.funnel || []) {
          if (!f || f.lift_abs == null) continue;
          const stage = f.text || f.funnel_stage || f.question_id || 'Stage';
          if (f.type === 'proportion') {
            const exPct = f.exposed?.rate != null ? `${Math.round(f.exposed.rate * 100)}%` : '?';
            const coPct = f.control?.rate != null ? `${Math.round(f.control.rate * 100)}%` : '?';
            const liftPts = `${Math.round(f.lift_abs * 100)} pts`;
            push(stage, `exposed ${exPct} vs control ${coPct} (+${liftPts}, ${sigLabel(f.significance)})`);
          } else if (f.type === 'mean') {
            const exM = f.exposed?.mean != null ? (num(f.exposed.mean) ?? '?') : '?';
            const coM = f.control?.mean != null ? (num(f.control.mean) ?? '?') : '?';
            push(stage, `exposed ${exM} vs control ${coM} (+${num(f.lift_abs) ?? f.lift_abs}, ${sigLabel(f.significance)})`);
          }
        }
        if (analysis.summary) {
          push('Funnel stages lifted', analysis.summary.stages_lifted);
          push('Stages significant at 95%', analysis.summary.stages_sig95);
        }
        // Cell base sizes are context, not the headline — surface them last.
        const ex = analysis.cells?.exposed?.n;
        const co = analysis.cells?.control?.n;
        if (ex != null) push('Exposed cell (n)', ex);
        if (co != null) push('Control cell (n)', co);
        break;
      }

      case 'roadmap': {
        // Top MaxDiff features by utility (already sorted utility desc).
        const feats = (analysis.maxdiff?.features || []).filter((f) => f && f.utility != null).slice(0, 5);
        for (const f of feats) {
          push(`MaxDiff: ${f.label || f.feature_id}`, `utility ${num(f.utility) ?? f.utility}`);
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
            push(`${c.label || c.candidate_id}${isWinner}`, `${num(c.pairwise_win_rate.pct, 1) ?? c.pairwise_win_rate.pct}% win rate`);
          } else if (c.composite != null) {
            push(`${c.label || c.candidate_id}${isWinner}`, `composite ${num(c.composite) ?? c.composite}`);
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
            push(`${c.label || c.concept_id}${isWinner}`, `${num(share, 1) ?? share}% forced choice`);
          } else if (c.dimensions?.appeal?.mean != null) {
            push(`${c.label || c.concept_id}${isWinner}`, `appeal ${num(c.dimensions.appeal.mean) ?? c.dimensions.appeal.mean}`);
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
          push(`Gap on "${g.attribute}" vs ${g.best_competitor}`, `${num(g.gap) ?? g.gap} pts`);
        }
        break;
      }

      case 'churn': {
        // Ranked drivers. Real analysis labels the driver `reason`; older
        // fixtures used `option`/`label` — accept all (Pass 48: `${d.option}`
        // rendered "Churn driver: undefined" against real data).
        for (const d of (analysis.drivers?.ranked || []).slice(0, 5)) {
          if (!d) continue;
          const reason = d.reason || d.option || d.label;
          if (!reason) continue;
          push(`Churn driver: ${reason}`, pct(d.pct_of_respondents));
        }
        if (analysis.winback?.winnable_pct != null) {
          push('Winnable (would return)', pct(analysis.winback.winnable_pct));
        }
        break;
      }

      case 'validate': {
        if (analysis.scores?.reaction?.mean != null) push('Concept reaction (mean of 10)', num(analysis.scores.reaction.mean));
        if (analysis.scores?.relevance?.mean != null) push('Relevance (mean of 7)', num(analysis.scores.relevance.mean));
        if (analysis.scores?.uniqueness?.mean != null) push('Uniqueness (mean of 7)', num(analysis.scores.uniqueness.mean));
        if (analysis.scores?.believability?.mean != null) push('Believability (mean of 7)', num(analysis.scores.believability.mean));
        push('Purchase intent (top-2-box)', pct(analysis.intent?.top2_pct));
        break;
      }

      case 'marketing': {
        const fn = analysis.funnel || {};
        if (fn.recall_aided?.correct_rate != null) push('Aided recall', `${Math.round(fn.recall_aided.correct_rate * 100)}%`);
        if (fn.attribution?.correct_rate != null) push('Correct brand attribution', `${Math.round(fn.attribution.correct_rate * 100)}%`);
        if (fn.likeability?.mean != null) push('Likeability (mean of 7)', num(fn.likeability.mean));
        if (fn.stopping_power?.mean != null) push('Stopping power (mean of 7)', num(fn.stopping_power.mean));
        if (fn.distinctiveness?.mean != null) push('Distinctiveness (mean of 7)', num(fn.distinctiveness.mean));
        if (fn.persuasion?.mean != null) push('Persuasion (mean of 7)', num(fn.persuasion.mean));
        if (fn.message_match?.rate != null) push('Message match', `${Math.round(fn.message_match.rate * 100)}%`);
        break;
      }

      case 'research': {
        // No methodology centerpiece — lead with the overall base size so the
        // top-line reads as a sample size, not a finding. (Pass 48: leading
        // with a per-question "n — <screener text>=5" misread as an answer.)
        if (analysis.n != null) push('Responses analyzed', analysis.n);
        for (const q of (analysis.per_question || []).slice(0, 12)) {
          if (!q) continue;
          const label = q.text ? `Base — ${String(q.text).slice(0, 60)}` : `Base — ${q.question_id}`;
          push(label, q.n);
        }
        break;
      }

      case 'audience_profiling': {
        if (analysis.posture === 'segmented' && Array.isArray(analysis.segments)) {
          push('Segments identified', analysis.segment_count);
          const primary = analysis.segments.find((s) => s.is_primary) || analysis.segments[0];
          if (primary) push('Primary segment', `${primary.name} (${num(primary.size_pct, 1) ?? primary.size_pct}%)`);
          for (const s of analysis.segments) {
            push(`Segment: ${s.name}`, `${num(s.size_pct, 1) ?? s.size_pct}% (n=${s.n})`);
          }
        } else {
          push('Segmentation', 'Aggregate profile only — sample too small to segment');
        }
        if (analysis.key_dimension) {
          const lbl = (analysis.dimensions || []).find((d) => d.key === analysis.key_dimension)?.label || analysis.key_dimension;
          push('Key differentiating dimension', lbl);
        }
        break;
      }

      case 'market_entry': {
        if (analysis.recommended_market) push('Recommended market', analysis.recommended_market);
        if (analysis.best_demand_index != null) push('Best demand index (0-100)', analysis.best_demand_index);
        for (const m of analysis.markets || []) {
          if (!m) continue;
          const sig = m.signal ? m.signal.replace('_', '-') : '—';
          const intent = m.purchase_intent_pct != null ? `${m.purchase_intent_pct}%` : '—';
          push(m.market, `demand ${m.demand_index ?? '—'}/100 · intent ${intent} · ${sig}${m.directional ? ' (directional)' : ''}`);
        }
        if (analysis.top_barrier) push('Top adoption barrier', analysis.top_barrier);
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
        exposed: f.exposed?.mean != null ? (num(f.exposed.mean) ?? '—') : '—',
        control: f.control?.mean != null ? (num(f.control.mean) ?? '—') : '—',
        lift: `+${num(f.lift_abs) ?? f.lift_abs}`,
        significance: sigLabel(f.significance),
        n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
      });
    }
  }
  return rows;
}

module.exports = { analysisHeadlines, brandLiftStageTable };
