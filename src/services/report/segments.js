/*
 * Pass 49 Phase 4 — response/segment filters.
 *
 * Architecture-first: filter a report by an answer-based or methodology-natural
 * segment, then rebuild the canonical report over the matching respondents so
 * EVERY surface inherits one source of truth (no forking). Decision (product):
 * segment by RESPONSE, never by thin synthetic demographics.
 *
 * Segment keys (opaque to the client; resolved here):
 *   nps:<promoter|passive|detractor>   — NPS band (satisfaction etc.)
 *   cell:<value>                       — brand_lift exposed/control cell
 *   ans:<questionId>:<value>           — answered <value> to <questionId>
 *
 * Honest n-gating: a segment whose subset is below SEG_FLOOR is never offered
 * (a 1-person cut must not read as a finding); the n is always surfaced.
 */

const { scaleNum } = require('./buildReport');

const SEG_FLOOR = 2; // do not offer a segment that resolves to fewer than this

function personaId(r) {
  return r.persona_id || (r.persona_profile && (r.persona_profile.persona_id || r.persona_profile.id)) || null;
}
function allPersonaIds(responses) {
  const s = new Set();
  for (const r of responses) { const p = personaId(r); if (p) s.add(p); }
  return s;
}
/** Map persona_id -> their answer for one question. */
function answerByPersona(responses, qid) {
  const m = new Map();
  for (const r of responses) {
    if (r.question_id !== qid) continue;
    const p = personaId(r);
    if (p && !m.has(p)) m.set(p, r.answer);
  }
  return m;
}
function shortText(t, n = 32) {
  const s = String(t || '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function npsBand(v) {
  const n = scaleNum(v);
  if (n == null) return null;
  if (n >= 9) return 'promoter';
  if (n >= 7) return 'passive';
  return 'detractor';
}

/** Identify the NPS question (0-10 likelihood-to-recommend), or null. */
function findNpsQuestion(questions, responses) {
  for (const q of questions || []) {
    if (q.isScreening) continue;
    if (q.type !== 'rating' && q.type !== 'nps' && q.type !== 'scale') continue;
    const text = String(q.text || '').toLowerCase();
    const meta = `${q.methodology || ''} ${q.funnel_stage || ''} ${q.kpi_category || ''}`.toLowerCase();
    if (meta.includes('nps') || /recommend/.test(text)) {
      // confirm the observed answers actually span a 0-10-ish range
      const nums = responses.filter((r) => r.question_id === q.id).map((r) => scaleNum(r.answer)).filter((v) => v != null);
      if (nums.length && Math.max(...nums) > 5) return q;
    }
  }
  return null;
}

/**
 * Build the list of OFFERABLE segments for a mission, each with its real n.
 * @returns {Array<{key,label,group,n}>}
 */
function buildSegments(mission, responses) {
  const questions = Array.isArray(mission.questions) ? mission.questions : [];
  const rows = Array.isArray(responses) ? responses : [];
  const total = allPersonaIds(rows).size;
  const out = [];

  // 1) NPS bands
  const npsQ = findNpsQuestion(questions, rows);
  if (npsQ) {
    const byP = answerByPersona(rows, npsQ.id);
    const counts = { promoter: 0, passive: 0, detractor: 0 };
    for (const v of byP.values()) { const b = npsBand(v); if (b) counts[b] += 1; }
    for (const band of ['promoter', 'passive', 'detractor']) {
      if (counts[band] >= SEG_FLOOR) {
        out.push({ key: `nps:${band}`, label: `NPS ${band}s`, group: 'NPS segment', n: counts[band] });
      }
    }
  }

  // 2) brand_lift exposed/control cell (persona_profile._exposure_status)
  if (mission.goal_type === 'brand_lift') {
    const byCell = {};
    const seen = new Set();
    for (const r of rows) {
      const p = personaId(r); if (!p || seen.has(p)) continue; seen.add(p);
      const cell = r.persona_profile && r.persona_profile._exposure_status;
      if (cell) byCell[cell] = (byCell[cell] || 0) + 1;
    }
    for (const [cell, n] of Object.entries(byCell)) {
      if (n >= SEG_FLOOR) out.push({ key: `cell:${cell}`, label: `${cell.charAt(0).toUpperCase()}${cell.slice(1)} cell`, group: 'Campaign cell', n });
    }
  }

  // 3) Generic by-answer (single + multi select, excluding screeners + the NPS q)
  for (const q of questions) {
    if (q.isScreening) continue;
    if (npsQ && q.id === npsQ.id) continue;
    if (q.type !== 'single' && q.type !== 'opinion' && q.type !== 'multi' && q.type !== 'multi_select') continue;
    const isMulti = q.type === 'multi' || q.type === 'multi_select';
    // count personas per option value
    const counts = new Map();
    const seen = new Set();
    for (const r of rows) {
      if (r.question_id !== q.id) continue;
      const p = personaId(r); if (!p || seen.has(p)) continue; seen.add(p);
      const vals = isMulti ? (Array.isArray(r.answer) ? r.answer : [r.answer]) : [r.answer];
      for (const v of vals) { if (v == null || v === '') continue; const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); }
    }
    for (const [val, n] of counts.entries()) {
      if (n >= SEG_FLOOR && n < total) { // n<total: a segment that's everyone isn't a cut
        out.push({ key: `ans:${q.id}:${val}`, label: `${shortText(q.text)}: ${shortText(val, 28)}`, group: `Q${questions.indexOf(q) + 1} answer`, n });
      }
    }
  }

  return out;
}

/** Resolve a segment key to the set of matching persona_ids. */
function personaSetForSegment(mission, responses, key) {
  const rows = Array.isArray(responses) ? responses : [];
  if (!key || typeof key !== 'string') return null;
  const [type, ...rest] = key.split(':');

  if (type === 'nps') {
    const band = rest[0];
    const npsQ = findNpsQuestion(mission.questions || [], rows);
    if (!npsQ) return new Set();
    const byP = answerByPersona(rows, npsQ.id);
    const set = new Set();
    for (const [p, v] of byP.entries()) if (npsBand(v) === band) set.add(p);
    return set;
  }
  if (type === 'cell') {
    const cell = rest.join(':');
    const set = new Set();
    for (const r of rows) {
      const p = personaId(r); if (!p) continue;
      if (r.persona_profile && r.persona_profile._exposure_status === cell) set.add(p);
    }
    return set;
  }
  if (type === 'ans') {
    const qid = rest[0];
    const val = rest.slice(1).join(':'); // value may contain ':'
    const q = (mission.questions || []).find((x) => x.id === qid);
    const isMulti = q && (q.type === 'multi' || q.type === 'multi_select');
    const set = new Set();
    for (const r of rows) {
      if (r.question_id !== qid) continue;
      const p = personaId(r); if (!p) continue;
      const vals = isMulti ? (Array.isArray(r.answer) ? r.answer : [r.answer]) : [r.answer];
      if (vals.some((v) => String(v) === val)) set.add(p);
    }
    return set;
  }
  return null;
}

/** Filter response rows to a segment. Returns null when the key is unknown. */
function filterResponsesBySegment(mission, responses, key) {
  const set = personaSetForSegment(mission, responses, key);
  if (!set) return null;
  return (responses || []).filter((r) => set.has(personaId(r)));
}

module.exports = { buildSegments, personaSetForSegment, filterResponsesBySegment, SEG_FLOOR };
