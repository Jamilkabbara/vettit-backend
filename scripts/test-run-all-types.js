#!/usr/bin/env node
/*
 * [AUDIT-PASS] live e2e runner — one clean FRESH mission per SURVEY research
 * type, end to end, owner-owned, at $0 (no Stripe; LLM spend only). Proves the
 * LIVE path (survey generation -> persona simulation -> deterministic analysis
 * -> synthesis -> canonical report -> export) works per type, not just exports
 * on stored data.
 *
 * Same trusted in-process pattern as test-run-mission.js: it BYPASSES the HTTP
 * create/checkout gate by inserting the mission directly and calling runMission()
 * in-process. It imports NO Stripe/payments module, opens NO checkout session,
 * and does NOT touch src/config/comingSoon.js — it un-gates NOTHING. A gated
 * type runs here while staying gated for real customers.
 *
 * COVERAGE: 13 survey types. creative_attention is EXCLUDED on purpose — it is
 * asset/vision-driven (zero survey responses), so "survey gen -> simulation"
 * does not apply; it stays on its own separate track.
 *
 * ISOLATION: every mission is titled "[AUDIT-PASS] <goal> ..." so it is walled
 * off from real data and swept in one pass by scripts/purge-audit-pass.js.
 *
 * OWNER-RUN, STAGED (real Anthropic spend + prod writes). Run canary first,
 * then the small batch, then the large batch. <outDir> collects mission IDs,
 * all three exports per type, and a per-type audit JSON.
 *
 *   node scripts/test-run-all-types.js <outDir> --plan            # cost/plan, no spend
 *   node scripts/test-run-all-types.js <outDir> --batch canary    # 1 cheap type
 *   node scripts/test-run-all-types.js <outDir> --batch small     # the n=40 types
 *   node scripts/test-run-all-types.js <outDir> --batch large     # AP/ME/research
 *   node scripts/test-run-all-types.js <outDir> --only pricing     # a single type
 *   node scripts/test-run-all-types.js <outDir> --only pricing --respondents 20
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const supabase = require('../src/db/supabase');
const ai = require('../src/services/claudeAI');
const { runMission } = require('../src/jobs/runMission');
const { sanitizeMissionPatch } = require('../src/db/missionSchema');
const { FIXTURES: DRY_FIXTURES } = require('./test-all-methodologies');
const { buildPDF } = require('../src/services/exports/pdf-v2');
const { buildPPTX } = require('../src/services/exports/pptx');
const { buildXLSX } = require('../src/services/exports/xlsx');

const OWNER_EMAIL = (process.env.TEST_MISSION_OWNER_EMAIL || 'kabbarajamil@gmail.com').toLowerCase();

// Audit-N per type (owner-approved). Floors cleared where analysis needs them:
// market_entry MIN_RELIABLE_N=30 per market (2 markets -> 80), audience_profiling
// needs >=50 qualified to segment. research kept at 100 to stress the generic
// path (owner call). Everything else at a modest 40 that still yields real
// distributions. All overridable with --respondents N.
const AUDIT_N = {
  validate: 40, compare: 40, marketing: 40, pricing: 40, roadmap: 40,
  brand_lift: 40, satisfaction: 40, competitor: 40, naming_messaging: 40,
  churn_research: 40, audience_profiling: 60, market_entry: 80, research: 100,
};

// Staged batches: canary (prove the whole chain on the cheapest type) -> small
// -> large. 1 + 9 + 3 = 13.
const BATCHES = {
  canary: ['validate'],
  small: ['compare', 'marketing', 'pricing', 'roadmap', 'satisfaction', 'competitor', 'naming_messaging', 'churn_research', 'brand_lift'],
  large: ['audience_profiling', 'market_entry', 'research'],
};
const ALL_TYPES = [...BATCHES.canary, ...BATCHES.small, ...BATCHES.large];

// Rough Anthropic cost heuristic for the PLAN only. Actuals come from
// mission.ai_cost_usd (accumulated by anthropic.js) and are the source of truth.
const PER_PERSONA_EST_USD = 0.11;
const estCost = (n) => Math.round((n * PER_PERSONA_EST_USD + 0.5) * 100) / 100;

// Fixtures not present in test-all-methodologies.js: research (generic) + the two
// gated types (need targeting.geography.countries so the persona generator spans
// the right markets — market_entry splits demand by respondent country).
const EXTRA_FIXTURES = {
  research: {
    goal: 'research',
    description: 'Understand how UAE grocery shoppers choose between quick-commerce delivery apps and what would make them switch their primary app.',
    clarify: {
      brand_name: 'GroceryGo',
      category: 'Quick-commerce grocery delivery',
      audience_description: 'Urban UAE adults 24-45 who order groceries online at least monthly',
    },
  },
  market_entry: {
    goal: 'market_entry',
    description: 'Validate demand for a premium chilled plant-based ready-meal line as we consider entering Saudi Arabia and Egypt. We currently sell only in the UAE and want appeal, purchase intent, willingness to pay, and the local barriers plus competitors in each new market.',
    clarify: {
      concept_description: 'A premium chilled plant-based ready-meal line (15-minute prep, restaurant-quality)',
      current_market: 'UAE',
      target_markets: 'Saudi Arabia, Egypt',
      price: 'AED 25 to 35 per meal',
      positioning: 'premium convenience',
    },
    targeting: { geography: { countries: ['SA', 'EG'] } },
  },
  audience_profiling: {
    goal: 'audience_profiling',
    description: 'Profile and segment the audience for a mid-market men grooming subscription in the UAE so we can sharpen targeting and messaging. We want the distinct attitudinal and behavioural segments, their sizes, and what defines each.',
    clarify: {
      category: 'Men grooming subscription',
      segmentation_focus: 'attitudes toward premium vs value, convenience, novelty, and brand loyalty',
      markets: 'UAE',
    },
    targeting: { geography: { countries: ['AE'] } },
  },
};

function fixtureFor(goal) {
  if (EXTRA_FIXTURES[goal]) return EXTRA_FIXTURES[goal];
  const fx = DRY_FIXTURES[goal];
  if (!fx) throw new Error(`no fixture for goal '${goal}'`);
  return { goal, description: fx.description, clarify: fx.clarify };
}

// ── c2: does the generated survey match the goal? Heuristic signature checks
//    the owner eyeballs; not a hard gate. ──────────────────────────────────
function signatureFor(goal, questions) {
  const txt = questions.map((q) => `${q.text || ''} ${q.type || ''} ${q.methodology || ''} ${q.kano_type || ''} ${(q.options || []).join(' ')}`.toLowerCase());
  const joined = txt.join(' || ');
  const has = (re) => txt.some((t) => re.test(t));
  const countMatch = (re) => txt.filter((t) => re.test(t)).length;
  const hasType = (t) => questions.some((q) => q.type === t);
  switch (goal) {
    case 'pricing': { const vw = countMatch(/too (cheap|expensive)|bargain|getting expensive|acceptable price|at what price|willing to pay|price.*fair/); return { match: vw >= 2, note: `Van Westendorp / price-sensitivity questions: ${vw}` }; }
    case 'satisfaction': { const nps = has(/recommend/) && (hasType('nps') || questions.some((q) => /0\D*10|zero to ten/.test(`${q.text} ${(q.options || []).join(' ')}`.toLowerCase()))); return { match: has(/recommend|satisf|effort/), note: nps ? 'NPS recommend (0-10) + CSAT/CES present' : 'CSAT/CES present (verify NPS on eyeball)' }; }
    case 'naming_messaging': { const names = ['aurora', 'nimbus', 'cinder', 'velvet']; const hit = names.filter((n) => joined.includes(n)).length; return { match: hit >= 2, note: `candidate names compared: ${hit}/4` }; }
    case 'compare': { const c = ['mealmate pro', 'plate plan']; const hit = c.filter((n) => joined.includes(n)).length; return { match: hit >= 2, note: `concepts compared: ${hit}/2` }; }
    case 'roadmap': { const md = hasType('max_diff_set') || has(/most.*least|max.?diff/); const kano = has(/kano|how would you feel|if .* (had|did ?n.t|lacked)/); return { match: md || kano, note: `MaxDiff:${md} Kano:${kano}` }; }
    case 'competitor': { const brands = ['talabat', 'careem', 'noon', 'instashop']; const hit = brands.filter((b) => joined.includes(b)).length; return { match: hit >= 2, note: `competitor brands present: ${hit}` }; }
    case 'brand_lift': { const funnel = questions.some((q) => q.funnel_stage); return { match: funnel || has(/aware|consider|recall|familiar|intent/), note: funnel ? 'funnel-staged' : 'awareness/consideration questions present' }; }
    case 'market_entry': { const s = ['appeal', 'pay', 'barrier', 'intent', 'purchase']; const hit = s.filter((k) => joined.includes(k)).length; return { match: hit >= 3, note: `market-entry signals (appeal/intent/WTP/barrier): ${hit}/5` }; }
    case 'audience_profiling': return { match: questions.length >= 4, note: `profiling battery: ${questions.length} questions` };
    case 'validate': return { match: has(/interested|purchase|likely to (buy|use|try)|appeal/), note: 'concept + purchase intent' };
    case 'marketing': return { match: has(/ad\b|recall|message|brand|campaign/), note: 'ad-effectiveness questions' };
    case 'churn_research': return { match: has(/cancel|leav|stop|churn|why did you|no longer|switch/), note: 'churn-driver questions' };
    case 'research': return { match: questions.length >= 1, note: `generic survey: ${questions.length} questions` };
    default: return { match: true, note: 'n/a' };
  }
}

// ── c4: analysis populated (no empty WTP / segments — the D3-class check on
//    FRESH data). ────────────────────────────────────────────────────────
function analysisCheck(goal, a, ins) {
  const issues = [];
  a = a || {}; ins = ins || {};
  if (!a.methodology) issues.push('analysis missing methodology');
  if (!ins.executive_summary) issues.push('no executive_summary');
  if (goal === 'market_entry') {
    const mk = a.markets || [];
    if (!mk.length) issues.push('no markets analysed');
    for (const x of mk) {
      if (x.demand_index == null) issues.push(`market ${x.market}: demand_index null`);
      const wtp = x.wtp ?? x.wtp_band ?? x.willingness_to_pay ?? x.price_band ?? x.wtp_range;
      if (wtp == null || wtp === '' || String(wtp).toLowerCase() === 'n/a') issues.push(`market ${x.market}: WTP n/a (D3-class)`);
    }
  }
  if (goal === 'audience_profiling') {
    const seg = a.segments || [];
    if (!seg.length) issues.push('segments empty / aggregate-only (below segmentation floor?)');
  }
  if (goal === 'pricing') {
    const hasWtp = a.van_westendorp || a.optimal_price || a.wtp || a.price_points || a.gabor_granger;
    if (!hasWtp) issues.push('pricing: no WTP / price-point structure in analysis');
  }
  return { populated: issues.length === 0, methodology: a.methodology || null, n: a.n ?? null, recs: (ins.recommendations || []).length, personas: (ins.personas || []).length, issues };
}

// ── export sinks (mirror the acceptance harness) ─────────────────────────
const sinkRes = () => { let buf = null; const r = { setHeader() {}, status() { return r; }, json() {}, end(b) { buf = b; }, get headersSent() { return false; }, _buf: () => buf }; return r; };
const bufRes = () => { const ps = new PassThrough(); ps.chunks = []; ps.on('data', (c) => ps.chunks.push(c)); ps.setHeader = () => {}; ps.status = () => ps; ps.json = () => {}; ps.done = new Promise((r) => ps.on('end', r)); return ps; };

async function renderExports(pack, outDir, tag) {
  const out = { tag };
  try { const r = sinkRes(); await buildPDF(pack, r); const b = r._buf(); fs.writeFileSync(path.join(outDir, `${tag}.pdf`), b); out.pdf = b ? b.length : 0; } catch (e) { out.pdfErr = e.message; }
  try { const r = sinkRes(); await buildPPTX(pack, r); const b = r._buf(); fs.writeFileSync(path.join(outDir, `${tag}.pptx`), b); out.pptx = b ? b.length : 0; } catch (e) { out.pptxErr = e.message; }
  try { const r = bufRes(); await buildXLSX(pack, r); await r.done; const b = Buffer.concat(r.chunks); fs.writeFileSync(path.join(outDir, `${tag}.xlsx`), b); out.xlsx = b.length; } catch (e) { out.xlsxErr = e.message; }
  out.allClean = !out.pdfErr && !out.pptxErr && !out.xlsxErr && out.pdf > 0 && out.pptx > 0 && out.xlsx > 0;
  return out;
}

async function resolveOwnerId(email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 200) break;
  }
  throw new Error(`owner not found for email ${email} (set TEST_MISSION_OWNER_EMAIL?)`);
}

// Merge one run into the on-disk accumulator so batches build up one report.
function persistSummary(outDir, row) {
  const jsonPath = path.join(outDir, '_audit-summary.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { all = {}; }
  all[row.goal] = row;
  fs.writeFileSync(jsonPath, JSON.stringify(all, null, 2));
  // mission-ids.txt for the rasterize harness (goal<TAB>id).
  const ids = Object.values(all).filter((r) => r.missionId).map((r) => `${r.goal}\t${r.missionId}`).join('\n');
  fs.writeFileSync(path.join(outDir, '_mission-ids.txt'), ids + '\n');
  // human-readable markdown.
  const order = ALL_TYPES.filter((g) => all[g]);
  const lines = ['# [AUDIT-PASS] live e2e — per-type results', '', '| type | mission | N (tgt/got) | c1 completes | c2 survey | c3 personas | c4 analysis | c5 exports | $ actual |', '|---|---|---|---|---|---|---|---|---|'];
  let tot = 0;
  for (const g of order) {
    const r = all[g];
    tot += Number(r.costActualUsd || 0);
    const c1 = r.c1?.completes ? 'ok' : `FAIL (${r.c1?.status || '?'}${r.c1?.threw ? ' threw' : ''})`;
    const c2 = r.c2?.match ? `ok (${r.c2.note})` : `CHECK (${r.c2?.note || '?'})`;
    const c3 = `${r.c3?.delivered ?? '?'}/${r.c3?.target ?? '?'}${r.c3?.directional ? ' directional' : ''}`;
    const c4 = r.c4?.populated ? `ok (n=${r.c4.n ?? '?'})` : `GAPS: ${(r.c4?.issues || []).join('; ')}`;
    const c5 = r.c5?.allClean ? 'ok' : `ISSUE (${['pdf', 'pptx', 'xlsx'].filter((k) => r.c5?.[`${k}Err`]).join(',') || 'empty'})`;
    lines.push(`| ${g} | ${r.missionId ? r.missionId.slice(0, 8) : '-'} | ${r.c3?.target ?? '?'}/${r.c3?.delivered ?? '?'} | ${c1} | ${c2} | ${c3} | ${c4} | ${c5} | ${r.costActualUsd != null ? '$' + r.costActualUsd : '?'} |`);
  }
  lines.push('', `**Runs: ${order.length}/13. Actual Anthropic spend so far: $${Math.round(tot * 100) / 100}.**`, '', 'Rasterize + visual read: `node scripts/export-acceptance-harness.js <outDir> $(cut -f2 <outDir>/_mission-ids.txt)`', 'Teardown when done: `node scripts/purge-audit-pass.js --apply`');
  fs.writeFileSync(path.join(outDir, '_audit-summary.md'), lines.join('\n'));
}

async function runOne(goal, opts, outDir, ownerId) {
  const fx = fixtureFor(goal);
  const N = Number.isFinite(opts.respondents) && opts.respondents > 0 ? opts.respondents : (AUDIT_N[goal] || 40);
  const brief = fx.description;
  console.log(`\n─── ${goal} (N=${N}, est ~$${estCost(N)}) ───`);

  console.log('  [1/4] generating survey (same generator the UI calls)…');
  const survey = await ai.generateSurvey({ goal, description: brief, clarify: fx.clarify, targetingHints: fx.targeting || {} });
  const questions = Array.isArray(survey?.questions) ? survey.questions : [];
  if (!questions.length) { console.log('  FAIL: survey generation returned no questions.'); return { goal, missionId: null, c1: { completes: false, status: 'no-survey' } }; }
  const c2 = signatureFor(goal, questions);
  console.log(`        ${questions.length} questions — c2 survey match: ${c2.match ? 'OK' : 'CHECK'} (${c2.note})`);

  const { patch } = sanitizeMissionPatch({
    user_id: ownerId,
    title: `[AUDIT-PASS] ${goal} — ${survey.productName || brief.slice(0, 32)}`,
    goal_type: goal,
    brief,
    mission_statement: survey.missionStatement || brief,
    questions,
    targeting: fx.targeting,
    targeted_markets: fx.targeted_markets,
    respondent_count: N,
    status: 'paid',
    paid_at: new Date().toISOString(),
    total_price_usd: 0,
    paid_amount_cents: 0,
  });
  const { data: inserted, error: insErr } = await supabase.from('missions').insert(patch).select('id').single();
  if (insErr || !inserted) { console.log(`  FAIL: insert: ${insErr?.message}`); return { goal, missionId: null, c1: { completes: false, status: 'insert-failed' } }; }
  const missionId = inserted.id;
  console.log(`  [2/4] created [AUDIT-PASS] mission ${missionId.slice(0, 8)} — running pipeline (minutes)…`);

  let threw = null;
  try { await runMission(missionId); } catch (e) { threw = e.message; }

  const { data: m } = await supabase.from('missions').select('*').eq('id', missionId).single();
  const { data: respRows } = await supabase.from('mission_responses').select('persona_id, screened_out').eq('mission_id', missionId).limit(20000);
  const clean = (respRows || []).filter((r) => r && r.screened_out !== true);
  const delivered = new Set(clean.map((r) => r.persona_id).filter(Boolean)).size || clean.length;

  const c1 = { completes: m?.status === 'completed' && !m?.failure_reason && questions.length > 0 && !threw, status: m?.status || '?', failure: m?.failure_reason || null, threw };
  const c3 = { target: N, delivered, directional: delivered < N, note: delivered < N ? `fewer than target (tight screener?) — directional posture expected` : 'target met' };
  const c4 = analysisCheck(goal, m?.analysis, m?.insights);

  console.log(`  [3/4] pipeline: status=${c1.status}${threw ? ` THREW: ${threw}` : ''} · personas ${delivered}/${N} · analysis ${c4.populated ? 'OK' : 'GAPS: ' + c4.issues.join('; ')}`);

  console.log('  [4/4] rendering exports off fresh data…');
  const { data: fullResp } = await supabase.from('mission_responses').select('*').eq('mission_id', missionId).limit(20000);
  const c5 = await renderExports({ mission: m, responses: (fullResp || []).filter((r) => r && r.screened_out !== true) }, outDir, `${goal}_${missionId.slice(0, 8)}`);
  console.log(`        exports: ${c5.allClean ? 'all clean' : 'ISSUE ' + ['pdf', 'pptx', 'xlsx'].filter((k) => c5[`${k}Err`]).map((k) => `${k}:${c5[`${k}Err`]}`).join(' ')}`);

  const costActualUsd = m?.ai_cost_usd != null ? Math.round(Number(m.ai_cost_usd) * 100) / 100 : null;
  const row = { goal, missionId, target: N, c1, c2, c3, c4, c5, costActualUsd, questionKinds: questions.map((q) => q.type || q.renderer || '?') };
  persistSummary(outDir, row);
  console.log(`  DONE ${goal} · actual $${costActualUsd ?? '?'} · mission ${missionId}`);
  return row;
}

function parseArgs(argv) {
  const a = { outDir: null, batch: null, only: null, respondents: null, plan: false, all: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '--plan' || t === '--dry-run') a.plan = true;
    else if (t === '--all') a.all = true;
    else if (t === '--batch') a.batch = rest[i += 1];
    else if (t === '--only') a.only = rest[i += 1];
    else if (t === '--respondents') a.respondents = parseInt(rest[i += 1], 10);
    else if (!t.startsWith('--') && !a.outDir) a.outDir = t;
  }
  return a;
}

(async () => {
  const args = parseArgs(process.argv);
  const outDir = args.outDir;
  if (!outDir) { console.error('Usage: node scripts/test-run-all-types.js <outDir> [--plan|--batch canary|small|large|--only <goal>] [--respondents N]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  let types;
  if (args.only) types = [args.only];
  else if (args.batch) { types = BATCHES[args.batch]; if (!types) { console.error(`unknown batch '${args.batch}' (canary|small|large)`); process.exit(1); } }
  else types = ALL_TYPES;

  // Plan / cost preview — always shown, no spend.
  const planTotal = types.reduce((s, g) => s + estCost(args.respondents || AUDIT_N[g] || 40), 0);
  const fullTotal = ALL_TYPES.reduce((s, g) => s + estCost(AUDIT_N[g]), 0);
  console.log('\n=== [AUDIT-PASS] live e2e plan ===');
  console.log(`outDir:   ${outDir}`);
  console.log(`selected: ${types.join(', ')}`);
  console.log('  type                 N     est $');
  for (const g of types) { const n = args.respondents || AUDIT_N[g] || 40; console.log(`  ${g.padEnd(20)} ${String(n).padStart(4)}  ~$${estCost(n)}`); }
  console.log(`  ${'-'.repeat(34)}`);
  console.log(`  selected est:        ~$${Math.round(planTotal * 100) / 100}   |   all 13 est: ~$${Math.round(fullTotal * 100) / 100}`);
  console.log('  (estimate only; actual per-type cost read from mission.ai_cost_usd after each run.)');
  console.log('  NOTE: $0 to customers — inserts status=paid directly + runs in-process. No Stripe, no checkout, comingSoon.js untouched.');

  if (args.plan) { console.log('\nPLAN ONLY — no survey generated, no mission created, no spend. Drop --plan to run.'); process.exit(0); }

  const ownerId = await resolveOwnerId(OWNER_EMAIL);
  console.log(`\nowner: ${OWNER_EMAIL} (${ownerId})`);
  console.log(`running ${types.length} type(s) sequentially…`);

  const results = [];
  for (const g of types) {
    try { results.push(await runOne(g, { respondents: args.respondents }, outDir, ownerId)); }
    catch (e) { console.error(`  FATAL on ${g}: ${e.message}`); results.push({ goal: g, missionId: null, c1: { completes: false, status: 'fatal', threw: e.message } }); }
  }

  const okC1 = results.filter((r) => r.c1?.completes).length;
  const spend = results.reduce((s, r) => s + Number(r.costActualUsd || 0), 0);
  console.log(`\n=== batch done: ${okC1}/${results.length} completed clean · actual spend $${Math.round(spend * 100) / 100} ===`);
  console.log(`Report: ${path.join(outDir, '_audit-summary.md')}`);
  console.log(`Mission IDs: ${path.join(outDir, '_mission-ids.txt')}`);
  console.log('Next: rasterize + visual read via export-acceptance-harness.js on those IDs; teardown via purge-audit-pass.js.');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
