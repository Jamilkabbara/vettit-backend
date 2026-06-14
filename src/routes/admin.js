const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const supabase = require('../db/supabase'); // service-role client for all admin queries (RPC + tables)
const logger = require('../utils/logger');
// Pass 42 F2 — Stripe promo sync. Lazy fail at call time so a
// missing STRIPE_SECRET_KEY doesn't crash the route module load.
const { createPromoOnStripe, updateStripePromoActive } = require('../services/stripe');

// All routes are gated: authenticate → adminOnly
router.use(authenticate, adminOnly);

// ─── Pass 22 Bug 22.6 ──────────────────────────────────────────────────────
// Admin RPC calls use the service-role singleton (`supabase`) directly.
//
// Previously this file built a per-request user-scoped client (userSupabase())
// that passed the caller's JWT through to PostgREST. That made RPC calls run
// AS `authenticated`, so the SECURITY DEFINER `is_admin_user(auth.uid())`
// guard inside each admin RPC could verify the caller's email.
//
// Pass 22 Bug 22.6 removed that guard from the 8 admin RPCs and revoked
// EXECUTE on those functions from PUBLIC/anon/authenticated. The route
// itself is gated by `authenticate + adminOnly` middleware (above), so the
// app-layer admin gate is the sole admin check. Calling via service_role
// from the backend bypasses the (now-removed) inner guard cleanly.
// ─────────────────────────────────────────────────────────────────────────

// ── Range helper ─────────────────────────────────────────────────────────────
function resolveRange(range) {
  const end = new Date();
  let start;
  switch (range) {
    case 'month':   start = new Date(end.getFullYear(), end.getMonth(), 1); break;
    case 'quarter': start = new Date(end.getFullYear(), Math.floor(end.getMonth() / 3) * 3, 1); break;
    case 'all':     start = new Date('2024-01-01'); break;
    default:        start = new Date(end.getTime() - 30 * 24 * 3600 * 1000); // 30d
  }
  const days = Math.round((end - start) / 86400000);
  return { start, end, days };
}
function calcDelta(curr, prev) { return prev > 0 ? Math.round(100 * (curr - prev) / prev) : 0; }

/**
 * GET /api/admin/overview?range=30d|month|quarter|all
 */
router.get('/overview', async (req, res, next) => {
  try {
    const { start, end } = resolveRange(req.query.range || '30d');
    const priorStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

    const [summary, priorSummary, funnel, segments, activity] = await Promise.all([
      supabase.rpc('admin_ai_cost_summary', { range_start: start, range_end: end }),
      supabase.rpc('admin_ai_cost_summary', { range_start: priorStart, range_end: start }),
      supabase.rpc('admin_funnel', { range_start: start, range_end: end }),
      supabase.rpc('admin_user_segments'),
      supabase.rpc('admin_activity_feed', { row_limit: 20 }),
    ]);

    // Mission type mix — Pass 23 Bug 23.30 fix.
    //
    // Pre-fix: query filtered `paid_at >= start AND paid_at < end`,
    // dropping missions paid before the range start. Display showed
    // a percentage breakdown that didn't sum to the total_missions KPI
    // because the two queries used different windows (KPI from RPC,
    // type mix here). Result was "Validate 5 / 83% + Marketing 1 / 17%"
    // when the actual completed set was wider.
    //
    // Fix: drop the time-range filter on Mission Type Mix — it's a
    // STRUCTURAL breakdown of the platform's mission portfolio, not a
    // time-series. The KPI delta below already shows time-series
    // direction; the mix should reflect the whole completed set.
    // Also: NULL goal_type → 'unspecified' bucket (used to be elided).
    const { data: typeMix } = await supabase
      .from('missions')
      .select('goal_type')
      .in('status', ['paid', 'completed']);

    const mixCounts = {};
    (typeMix || []).forEach((m) => {
      const key = m.goal_type || 'unspecified';
      mixCounts[key] = (mixCounts[key] || 0) + 1;
    });
    const mixTotal = Object.values(mixCounts).reduce((a, b) => a + b, 0);
    // Two-decimal pct so 11/27 → 40.74% not 41% (the rounded display
    // hid sum-to-100 violations under .5/category. Frontend formats
    // back to 1-decimal for display.)
    const missionTypeMix = Object.entries(mixCounts)
      .map(([type, n]) => ({
        type,
        count: n,
        pct: mixTotal > 0 ? Number((100 * n / mixTotal).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Active users in range — count DISTINCT user_id, not mission rows.
    // Pass 21 Bug 1: prior code used `count: 'exact', head: true` on a SELECT
    // of user_id, which returns the row count (mission count), not the
    // distinct-user count. With 25 missions but ~2 active humans, the KPI
    // showed 25 instead of 2.
    const { data: activeUserRows } = await supabase
      .from('missions')
      .select('user_id')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .not('user_id', 'is', null);
    const activeUsers = new Set((activeUserRows || []).map(r => r.user_id)).size;

    const s  = summary.data      || {};
    const ps = priorSummary.data || {};
    const missionsPaid = (funnel.data || {}).paid || 0;
    const priorPaid    = ps.total_calls || 0;

    // Pass 23 Bug 23.29 — admin revenue cache stale ($158 cached vs
    // $185.50 actual). admin_ai_cost_summary is a server-side RPC that
    // may be backed by a materialized view or aggregate that hasn't
    // been refreshed since the latest mission completion. Compute a
    // fresh total directly from missions in this request and trust
    // the freshly-computed value when it diverges from the RPC by
    // more than $1. Defensive: if either is missing, prefer the other.
    const { data: liveRevRows } = await supabase
      .from('missions')
      .select('total_price_usd')
      .in('status', ['paid', 'completed'])
      .gte('paid_at', start.toISOString())
      .lt('paid_at', end.toISOString());
    const liveRev = (liveRevRows || []).reduce(
      (sum, r) => sum + Number(r.total_price_usd || 0),
      0,
    );
    const rpcRev = Number(s.total_revenue_usd) || 0;
    const totalRevenue = liveRev > 0 || rpcRev === 0 ? liveRev : rpcRev;

    // Match prior-window revenue via the same direct path so the delta
    // calc is apples-to-apples.
    const { data: priorRevRows } = await supabase
      .from('missions')
      .select('total_price_usd')
      .in('status', ['paid', 'completed'])
      .gte('paid_at', priorStart.toISOString())
      .lt('paid_at', start.toISOString());
    const priorTotalRev = (priorRevRows || []).reduce(
      (sum, r) => sum + Number(r.total_price_usd || 0),
      0,
    );

    // Defensive no-cache headers on /overview so browsers/CDNs don't
    // serve a stale response after a fresh mission completion.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      kpis: {
        total_missions: { value: missionsPaid, delta_pct: calcDelta(missionsPaid, priorPaid) },
        total_revenue:  { value: totalRevenue, delta_pct: calcDelta(totalRevenue, priorTotalRev) },
        active_users:   { value: activeUsers, delta_pct: 0 },
        avg_mission_value: {
          value: missionsPaid > 0 ? totalRevenue / missionsPaid : 0,
          delta_pct: 0,
        },
      },
      funnel:           funnel.data,
      // Pass 35 A2 — admin_user_segments RPC returns column `user_count`
      // but the frontend rendering reads `count`. Remap so the new
      // 4-bucket segmentation (Power / Active / Trial / Signed up only)
      // surfaces in the widget instead of "Unknown 0".
      segments: (segments.data || []).map((s) => ({
        segment: s.segment,
        count:   Number(s.user_count ?? s.count ?? 0),
        avg_ltv: Number(s.avg_ltv ?? 0),
        total_ltv: Number(s.total_ltv ?? 0),
      })),
      activity:         activity.data,
      missionTypeMix,
      gross_margin_pct: s.gross_margin_pct || 0,
      last_updated:     new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/missions — paginated, searchable, filterable.
 * ?limit&offset&status&goal_type&search
 */
router.get('/missions', async (req, res, next) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset    = parseInt(req.query.offset) || 0;
    const { search, status, goal_type } = req.query;

    // Pass 32 X5 — column names had drifted. The legacy SELECT asked
    // for `target_countries` (plural) and `promo_discount_usd`; the
    // missions table actually has `country` (singular) and
    // `discount_usd`. PostgREST returned a 400 on the select, the
    // whole row array came back empty, and AdminMissions surfaced
    // "Failed to load missions". Aligning with missionSchema.js
    // ALLOWED_COLUMNS so the query stays in sync with the schema.
    let q = supabase
      .from('missions')
      .select(
        `id, user_id, status, goal_type, brief, total_price_usd, ai_cost_usd,
         respondent_count, country, promo_code, discount_usd,
         created_at, paid_at, completed_at, executive_summary`,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)    q = q.eq('status', status);
    if (goal_type) q = q.eq('goal_type', goal_type);
    if (search)    q = q.ilike('brief', `%${search}%`);

    const { data, error, count } = await q;
    if (error) throw error;

    // Enrich with user profile
    const userIds = [...new Set((data || []).map(m => m.user_id).filter(Boolean))];
    const { data: profiles } = userIds.length
      ? await supabase.from('profiles').select('id, first_name, last_name, company_name').in('id', userIds)
      : { data: [] };
    const profileMap = {};
    for (const p of profiles || []) profileMap[p.id] = p;

    // Pass 33 W3 — per-mission ai_cost_usd rollup. The missions.ai_cost_usd
    // column is incremented by the increment_mission_ai_cost RPC after
    // every Anthropic call (anthropic.js:108). When that path errors or
    // when calls happen outside the rollup hook (e.g. failed-call retries
    // that bypass the rollup), missions.ai_cost_usd drifts low and the
    // admin Missions tab shows $0.00 even on completed missions that
    // burned real spend. Truth source is ai_calls.cost_usd summed by
    // mission_id (Pass 32 X7 verified $1.89 aggregate from this path).
    const missionIds = (data || []).map(m => m.id).filter(Boolean);
    const { data: aiCalls } = missionIds.length
      ? await supabase.from('ai_calls').select('mission_id, cost_usd').in('mission_id', missionIds)
      : { data: [] };
    const aiCostByMission = {};
    for (const c of (aiCalls || [])) {
      if (!c.mission_id) continue;
      aiCostByMission[c.mission_id] = (aiCostByMission[c.mission_id] || 0) + Number(c.cost_usd || 0);
    }

    const enriched = (data || []).map(m => {
      // Use the live ai_calls rollup as truth; fall back to the stored
      // column only when there are no ai_calls rows (legacy missions
      // pre-rollup or test fixtures).
      const liveAiCost = aiCostByMission[m.id] != null
        ? Math.round(aiCostByMission[m.id] * 10000) / 10000
        : Number(m.ai_cost_usd || 0);
      return {
        ...m,
        ai_cost_usd: liveAiCost,
        user:        profileMap[m.user_id] || null,
        margin_usd:  Number(m.total_price_usd || 0) - liveAiCost,
      };
    });

    res.json({ data: enriched, total: count, limit, offset });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/users — paginated user list with mission stats.
 * ?limit&offset&search&segment
 */
router.get('/users', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { search } = req.query;

    let q = supabase
      .from('profiles')
      .select('id, first_name, last_name, full_name, company_name, role, project_stage, is_admin, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Pass 49 security (P2): `search` is interpolated into a PostgREST raw
    // filter string, so strip the metacharacters that could break out of the
    // intended `column.ilike.%value%` shape ( , . ( ) * % \ ). Admin-only, but
    // defense-in-depth against filter-injection.
    if (search) {
      const safe = String(search).replace(/[,.()*%\\]/g, ' ').trim();
      if (safe) q = q.or(`full_name.ilike.%${safe}%,company_name.ilike.%${safe}%`);
    }

    const { data: profiles, error, count } = await q;
    if (error) throw error;

    // Aggregate mission stats per user
    const ids = (profiles || []).map(p => p.id);
    const { data: missionStats } = ids.length
      ? await supabase.from('missions').select('user_id, status, total_price_usd').in('user_id', ids)
      : { data: [] };

    const statsMap = {};
    for (const m of missionStats || []) {
      if (!statsMap[m.user_id]) statsMap[m.user_id] = { mission_count: 0, ltv_usd: 0, paid_count: 0 };
      statsMap[m.user_id].mission_count++;
      if (['paid', 'completed'].includes(m.status)) {
        statsMap[m.user_id].ltv_usd    += Number(m.total_price_usd || 0);
        statsMap[m.user_id].paid_count++;
      }
    }

    const enriched = (profiles || []).map(p => ({
      ...p,
      ...(statsMap[p.id] || { mission_count: 0, ltv_usd: 0, paid_count: 0 }),
    }));

    res.json({ data: enriched, total: count, limit, offset });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/ai-costs — full RPC-based cost breakdown with deltas.
 * ?range=30d|month|quarter|all
 */
router.get('/ai-costs', async (req, res, next) => {
  try {
    const { start, end } = resolveRange(req.query.range || '30d');
    const priorStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

    // Pass 33 W2 — daily_revenue_buckets RPC returns columns named
    // `bucket_date` + `ai_cost_usd`, but the frontend chart binds to
    // `day` + `cost_usd` → keys silently undefined → chart empty even
    // though the aggregate ($1.89) was correct. Pulling daily buckets
    // directly from ai_calls (which Pass 32 X7 confirmed as the truth
    // source) and missions.paid_at lets us return the right key shape
    // and avoid the missions.ai_cost_usd stale-rollup problem in one
    // shot.
    const [summary, priorSummary, byOperation, modelMix, margins, dailyAi, dailyRev] = await Promise.all([
      supabase.rpc('admin_ai_cost_summary',      { range_start: start,      range_end: end }),
      supabase.rpc('admin_ai_cost_summary',      { range_start: priorStart, range_end: start }),
      supabase.rpc('admin_ai_cost_by_operation', { range_start: start,      range_end: end }),
      supabase.rpc('admin_ai_model_mix',         { range_start: start,      range_end: end }),
      supabase.rpc('admin_mission_margins',      { range_start: start,      range_end: end }),
      supabase.from('ai_calls').select('cost_usd, created_at')
        .gte('created_at', start.toISOString()).lt('created_at', end.toISOString()),
      supabase.from('missions').select('total_price_usd, paid_at')
        .in('status', ['paid', 'completed'])
        .gte('paid_at', start.toISOString()).lt('paid_at', end.toISOString()),
    ]);

    // Bucket by yyyy-mm-dd. Cost from ai_calls.cost_usd, revenue from
    // missions.total_price_usd. Round cost to 4dp (Anthropic prices in
    // fractions of cents) and revenue to 2dp.
    const aiByDay = {};
    for (const r of (dailyAi.data || [])) {
      const day = String(r.created_at || '').slice(0, 10);
      if (!day) continue;
      aiByDay[day] = (aiByDay[day] || 0) + Number(r.cost_usd || 0);
    }
    const revByDay = {};
    for (const r of (dailyRev.data || [])) {
      const day = String(r.paid_at || '').slice(0, 10);
      if (!day) continue;
      revByDay[day] = (revByDay[day] || 0) + Number(r.total_price_usd || 0);
    }
    const allDays = new Set([...Object.keys(aiByDay), ...Object.keys(revByDay)]);
    const dailyBuckets = Array.from(allDays).sort().map(day => ({
      day,
      cost_usd:    Math.round((aiByDay[day]  || 0) * 10000) / 10000,
      revenue_usd: Math.round((revByDay[day] || 0) * 100) / 100,
    }));

    // Pass 34 C3 — bucket non-mission calls by purpose so the admin
    // Operations Breakdown surfaces chatbot / clarify / targeting
    // spend that previously hid under "unattributed" (33.6% of calls).
    const { data: purposeRows } = await supabase
      .from('ai_calls')
      .select('purpose, cost_usd, mission_id')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString());
    const byPurposeAgg = {};
    for (const r of (purposeRows || [])) {
      const key = r.purpose || 'unknown_legacy';
      if (!byPurposeAgg[key]) byPurposeAgg[key] = { calls: 0, cost: 0, mission_bound: 0 };
      byPurposeAgg[key].calls += 1;
      byPurposeAgg[key].cost  += Number(r.cost_usd || 0);
      if (r.mission_id) byPurposeAgg[key].mission_bound += 1;
    }
    const byPurpose = Object.entries(byPurposeAgg).map(([purpose, v]) => ({
      purpose,
      calls:       v.calls,
      total_cost_usd: Math.round(v.cost * 10000) / 10000,
      avg_cost_usd:   v.calls > 0 ? Math.round((v.cost / v.calls) * 10000) / 10000 : 0,
      mission_bound: v.mission_bound,
    })).sort((a, b) => b.total_cost_usd - a.total_cost_usd);

    const s  = summary.data      || {};
    const ps = priorSummary.data || {};

    // Pass 32 X7 — admin_ai_cost_summary RPC returns the cost field as
    // `total_ai_cost_usd` (see migrations/pass-22/02_bug_22_6_*.sql line
    // 118). The route was reading `s.total_cost_usd`, which silently
    // resolved to undefined → frontend showed "$0.00 total" even with
    // 244 ai_calls rows present. Aligning the read to match the RPC.
    res.json({
      summary: {
        total_cost_usd:       { value: s.total_ai_cost_usd,    delta_pct: calcDelta(s.total_ai_cost_usd,    ps.total_ai_cost_usd)    },
        total_revenue_usd:    { value: s.total_revenue_usd,    delta_pct: calcDelta(s.total_revenue_usd,    ps.total_revenue_usd)    },
        gross_margin_pct:     { value: s.gross_margin_pct,     delta_pct: calcDelta(s.gross_margin_pct,     ps.gross_margin_pct)     },
        total_calls:          { value: s.total_calls,          delta_pct: calcDelta(s.total_calls,          ps.total_calls)          },
        avg_cost_per_mission: { value: s.avg_cost_per_mission, delta_pct: 0 },
        tiering_savings_usd:  s.tiering_savings_usd || 0,
      },
      // Pass 34 C7 — admin_ai_cost_by_operation RPC returns the avg
      // column as `avg_cost_per_call`; the frontend type expects
      // `avg_cost_usd`. Remap so the Avg Cost column renders. Same
      // pattern as Pass 32 X7's total_cost_usd / total_ai_cost_usd
      // mismatch.
      by_operation: (byOperation.data || []).map((row) => ({
        ...row,
        avg_cost_usd: Number(row.avg_cost_per_call ?? row.avg_cost_usd ?? 0),
      })),
      // Pass 34 C3 — non-mission calls bucketed by purpose so admin
      // can see chatbot / clarify / targeting spend separately.
      by_purpose:      byPurpose,
      model_mix:       modelMix.data    || [],
      mission_margins: margins.data     || [],
      daily_buckets:   dailyBuckets,
      last_updated:    new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/promo-codes
 * POST /api/admin/promo-codes   (create or upsert)
 * POST /api/admin/promo-codes/:code/disable
 */
router.get('/promo-codes', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/promo-codes', async (req, res, next) => {
  try {
    const { code, type, value, max_uses, expires_at, active = true } = req.body;
    if (!code || !type || value == null) return res.status(400).json({ error: 'code, type, value required' });
    const { data, error } = await supabase
      .from('promo_codes')
      .upsert({ code: code.toUpperCase(), type, value, max_uses, expires_at, active })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/promo-codes/:code/disable', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('promo_codes')
      .update({ active: false })
      .eq('code', req.params.code.toUpperCase());
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/crm — pipeline board.
 */
router.get('/crm', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('crm_leads')
      .select('*')
      .order('last_activity_at', { ascending: false, nullsFirst: false });
    if (error) throw error;

    // Group by stage for kanban view
    const stages = {};
    for (const lead of data || []) {
      stages[lead.stage] = stages[lead.stage] || [];
      stages[lead.stage].push(lead);
    }
    res.json({ leads: data, stages });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/support — tickets.
 */
router.get('/support', async (req, res, next) => {
  try {
    const { status } = req.query;
    let q = supabase.from('support_tickets').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * PATCH /api/admin/support/:id — update status / priority / admin_notes.
 *
 * Pass 35 A6 — admin UI needs this for the status/priority dropdowns
 * + Mark Resolved button. Auto-stamps resolved_at when status flips
 * to 'resolved' or 'closed'.
 */
router.patch('/support/:id', async (req, res, next) => {
  try {
    const { status, priority, admin_notes } = req.body || {};
    const patch = {};
    if (status     !== undefined) patch.status = status;
    if (priority   !== undefined) patch.priority = priority;
    if (admin_notes !== undefined) patch.admin_notes = admin_notes;
    if (status === 'resolved' || status === 'closed') {
      patch.resolved_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('support_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/support/:id/ai-draft — generate an AI response draft for a ticket.
 */
router.post('/support/:id/ai-draft', async (req, res, next) => {
  try {
    const { callClaude } = require('../services/ai/anthropic');
    const { data: ticket } = await supabase
      .from('support_tickets').select('*').eq('id', req.params.id).single();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const response = await callClaude({
      callType: 'chat_admin_crm',
      userId:   req.user.id,
      systemPrompt: `You are VETT customer support. Write a polite, helpful, concise response to the following ticket. End with an offer to help further if needed.`,
      messages: [{ role: 'user', content: `Subject: ${ticket.subject}\n\n${ticket.body}` }],
      maxTokens: 800,
    });

    await supabase
      .from('support_tickets')
      .update({ ai_draft_response: response.text })
      .eq('id', req.params.id);

    res.json({ draft: response.text });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/blog/generate — manual trigger for weekly blog gen.
 * (Stub: in v1 we call Sonnet with recent anonymized mission themes to synthesize a post.)
 */
router.post('/blog/generate', async (req, res, next) => {
  try {
    const { callClaude, extractJSON } = require('../services/ai/anthropic');
    // Grab last 10 completed missions (anonymized) as source material
    const { data: missions } = await supabase
      .from('missions')
      .select('goal_type, brief, executive_summary, insights')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(10);

    const source = (missions || []).map(m => ({
      goal: m.goal_type,
      topic: m.brief?.slice(0, 200),
      summary: m.executive_summary,
    }));

    const response = await callClaude({
      callType: 'blog_gen',
      userId:   req.user.id,
      systemPrompt: `You are VETT's editorial team. You write punchy, data-backed research blog posts that feel useful to founders, PMs, and marketers. Voice: sharp, clear, never clickbait.`,
      messages: [{ role: 'user', content:
        `Write a blog post based on themes from these recent anonymized research missions.

Source material (anonymized):
${JSON.stringify(source, null, 2)}

Return ONLY this JSON:
{
  "slug": "kebab-case-slug",
  "title": "Catchy title under 70 chars",
  "excerpt": "One-sentence hook under 180 chars",
  "body_markdown": "Full article in markdown (~600 words). Use subheads.",
  "tag": "AI Research|Pricing|Creative|Market Entry|Brand|Retention",
  "emoji": "📊"
}`
      }],
      maxTokens: 3000,
    });

    const post = extractJSON(response.text);
    const { data, error } = await supabase
      .from('blog_posts')
      .insert({
        ...post,
        published_at: new Date().toISOString(),
        source_mission_ids: (missions || []).map(m => m.id).filter(Boolean),
        auto_generated: true,
      })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// -------------------------------------------------------------------------
// Mission management actions (P2)
// -------------------------------------------------------------------------

/**
 * DELETE /api/admin/missions/:id
 * Hard-delete a mission + its responses/chat/notifications (cascades via FK).
 */
router.delete('/missions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Delete child rows first (FK constraints)
    await supabase.from('mission_responses').delete().eq('mission_id', id);
    await supabase.from('chat_sessions').delete().eq('mission_id', id);
    await supabase.from('notifications').delete().eq('mission_id', id);
    const { error } = await supabase.from('missions').delete().eq('id', id);
    if (error) throw error;
    logger.info('Admin deleted mission', { missionId: id, adminEmail: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/admin/missions/:id/force-complete
 * Set mission status = completed + stamp completed_at (for stuck missions).
 */
router.patch('/missions/:id/force-complete', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('missions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    logger.info('Admin force-completed mission', { missionId: id, adminEmail: req.user.email });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * Pass 42 F1 — POST /api/admin/missions/:id/mark-paid
 *
 * Admin override that promotes a `pending_payment` mission to `paid`
 * without involving Stripe. Used for internal / demo / comp missions.
 *
 * Body: { reason: string }  (required, logged to admin_actions)
 *
 * Side effects:
 *   - missions.paid_at = NOW()
 *   - missions.payment_method = 'admin_override'
 *   - missions.status = 'paid' (so the recruitment loop picks it up)
 *   - admin_actions row inserted with action_type='mark_mission_paid'
 *
 * NO REFUNDS, EVER. This endpoint moves a mission FORWARD (pending →
 * paid). There is no inverse endpoint that calls Stripe.refunds.
 */
router.post('/missions/:id/mark-paid', async (req, res, next) => {
  try {
    const { id } = req.params;
    const reason = (req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'reason_required', message: 'Reason is required for the audit log.' });
    }

    // Confirm the mission exists + is in a state where override makes sense.
    const { data: mission, error: fetchErr } = await supabase
      .from('missions')
      .select('id, user_id, status, paid_at, total_price_usd')
      .eq('id', id)
      .single();
    if (fetchErr || !mission) return res.status(404).json({ error: 'mission_not_found' });
    if (mission.status !== 'pending_payment' && mission.status !== 'draft') {
      return res.status(409).json({
        error: 'invalid_state',
        message: `Mission status is '${mission.status}'; mark-paid only applies to draft or pending_payment.`,
      });
    }

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('missions')
      .update({
        status:         'paid',
        paid_at:        now,
        payment_method: 'admin_override',
      })
      .eq('id', id);
    if (updErr) {
      logger.error('Admin mark-paid update failed', { missionId: id, err: updErr.message });
      return next(updErr);
    }

    const { error: auditErr } = await supabase
      .from('admin_actions')
      .insert({
        admin_user_id: req.user.id,
        action_type:   'mark_mission_paid',
        target_type:   'mission',
        target_id:     id,
        reason,
        metadata: {
          previous_status:  mission.status,
          total_price_usd:  mission.total_price_usd,
          paid_at:          now,
        },
      });
    if (auditErr) {
      // Non-fatal: the override succeeded but audit logging failed. Log the
      // failure prominently so we can backfill manually if needed.
      logger.error('Admin mark-paid audit insert failed (non-fatal)', {
        missionId: id, adminEmail: req.user.email, err: auditErr.message,
      });
    }

    logger.info('Admin marked mission paid', {
      missionId: id, adminEmail: req.user.email, reason,
    });

    // Pass 44 P0 — trigger the pipeline. The Stripe path triggers
    // runMission via webhook / payments-confirm; admin-marked missions
    // had NO trigger at all: generate-responses treats status='paid'
    // as "already running" (it assumes the webhook fired), and the
    // recovery cron only sweeps pending_payment. Every mark-paid
    // mission stranded at status='paid' forever. Same fire-and-forget
    // pattern as the webhook-miss recovery in missionRecovery.js.
    const { runMission } = require('../jobs/runMission');
    setImmediate(() => {
      runMission(id).catch((runErr) => {
        logger.error('Admin mark-paid: runMission trigger failed', {
          missionId: id, err: runErr.message,
        });
      });
    });

    res.json({ success: true, mission_id: id, paid_at: now, pipeline_triggered: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/missions/:id/reanalyze
 * Regenerate insights + executive_summary for an already-completed mission.
 *
 * Use case: a mission completed but the analysis step failed (mission_assets.analysis_error
 * is set, executive_summary is null/short). Persona responses are expensive and already
 * stored — only the synthesis layer needs to be re-run.
 *
 * Returns 200 { success, executive_summary_length, insights_keys } on success.
 */
router.post('/missions/:id/reanalyze', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Lazy-require to avoid pulling Anthropic SDK at module load time
    const { synthesizeInsights } = require('../services/ai/insights');

    // 1. Load mission
    const { data: mission, error: mErr } = await supabase
      .from('missions')
      .select('*')
      .eq('id', id)
      .single();
    if (mErr || !mission) return res.status(404).json({ error: 'Mission not found' });

    // 2. Load all responses (persona simulation already done)
    const { data: responseRows, error: rErr } = await supabase
      .from('mission_responses')
      .select('persona_id, persona_profile, question_id, answer, screened_out')
      .eq('mission_id', id);
    if (rErr) throw rErr;
    if (!responseRows || responseRows.length === 0) {
      return res.status(400).json({ error: 'No responses found for mission — cannot reanalyze' });
    }

    // 3. Synthesize
    const insights = await synthesizeInsights(mission, responseRows);

    // 4. Persist + clear stale analysis_error stamp
    const cleanedAssets = { ...(mission.mission_assets || {}) };
    delete cleanedAssets.analysis_error;
    const { error: uErr } = await supabase
      .from('missions')
      .update({
        executive_summary: insights?.executive_summary || null,
        insights:          insights || null,
        mission_assets:    cleanedAssets,
      })
      .eq('id', id);
    if (uErr) throw uErr;

    logger.info('Admin reanalyzed mission', {
      missionId: id,
      adminEmail: req.user.email,
      summaryLen: (insights?.executive_summary || '').length,
    });

    res.json({
      success: true,
      executive_summary_length: (insights?.executive_summary || '').length,
      insights_keys: Object.keys(insights || {}),
    });
  } catch (err) {
    logger.error('Admin reanalyze failed', { missionId: req.params.id, err: err.message });
    next(err);
  }
});

/**
 * POST /api/admin/missions/bulk-reanalyze
 *
 * Pass 21 Bug 20 — bulk-reanalyze stale missions in one admin action.
 *
 * "Stale" = status='completed' AND any of:
 *   • executive_summary IS NULL or shorter than 100 chars
 *   • insights IS NULL or {} (synthesis never ran)
 *   • mission_assets.analysis_error is set (synthesis errored mid-run)
 *
 * Body (all optional):
 *   { limit?: number, dryRun?: boolean }
 *
 * limit  — cost guardrail. synthesizeInsights is one Sonnet call per
 *          mission (~$0.10–0.30). Default 25, capped at 100.
 * dryRun — if true, returns the candidate list without spending tokens.
 *
 * Runs sequentially (not parallel) so we get a clean per-mission audit
 * trail and don't trip Anthropic rate limits when the queue is large.
 *
 * Response shape:
 *   { totalStale, processed, succeeded, failed,
 *     results: [{ missionId, ok, summaryLen?, error? }] }
 */
router.post('/missions/bulk-reanalyze', async (req, res, next) => {
  try {
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 25;
    const dryRun = !!req.body?.dryRun;

    const { synthesizeInsights } = require('../services/ai/insights');

    // 1. Find candidates. Use a single SQL with OR to match any of the
    // three stale signals. Order by completed_at ASC so we re-process the
    // oldest stale missions first (most likely to have user complaints).
    const { data: candidates, error: cErr } = await supabase
      .from('missions')
      .select('id, executive_summary, insights, mission_assets, completed_at')
      .eq('status', 'completed')
      .or('executive_summary.is.null,insights.is.null')
      .order('completed_at', { ascending: true })
      .limit(limit);
    if (cErr) throw cErr;

    // The .or() above only catches the NULL signals — short-summary and
    // analysis_error need a JS-side filter because PostgREST .or() can't
    // cleanly express length() or mission_assets ? 'analysis_error'.
    // Pull a wider net then refine below.
    const { data: extraCandidates } = await supabase
      .from('missions')
      .select('id, executive_summary, insights, mission_assets, completed_at')
      .eq('status', 'completed')
      .order('completed_at', { ascending: true })
      .limit(500);

    const stale = [];
    const seen = new Set();
    const isStale = (m) => {
      if (!m.executive_summary || m.executive_summary.length < 100) return true;
      if (!m.insights || (typeof m.insights === 'object' && Object.keys(m.insights).length === 0)) return true;
      if (m.mission_assets && m.mission_assets.analysis_error) return true;
      return false;
    };
    for (const m of [...(candidates || []), ...(extraCandidates || [])]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (isStale(m)) stale.push(m);
      if (stale.length >= limit) break;
    }

    if (dryRun) {
      return res.json({
        dryRun: true,
        totalStale: stale.length,
        candidateIds: stale.map(m => m.id),
      });
    }

    if (stale.length === 0) {
      return res.json({
        totalStale: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      });
    }

    // 2. Process sequentially — collect per-mission outcome.
    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const c of stale) {
      const missionId = c.id;
      try {
        // Reuse the same logic as POST /missions/:id/reanalyze.
        const { data: mission } = await supabase
          .from('missions').select('*').eq('id', missionId).single();
        if (!mission) throw new Error('mission not found');

        const { data: responseRows } = await supabase
          .from('mission_responses')
          .select('persona_id, persona_profile, question_id, answer, screened_out')
          .eq('mission_id', missionId);
        if (!responseRows || responseRows.length === 0) {
          throw new Error('no responses to reanalyze');
        }

        const insights = await synthesizeInsights(mission, responseRows);
        const cleanedAssets = { ...(mission.mission_assets || {}) };
        delete cleanedAssets.analysis_error;
        const { error: uErr } = await supabase
          .from('missions')
          .update({
            executive_summary: insights?.executive_summary || null,
            insights:          insights || null,
            mission_assets:    cleanedAssets,
          })
          .eq('id', missionId);
        if (uErr) throw uErr;

        const summaryLen = (insights?.executive_summary || '').length;
        results.push({ missionId, ok: true, summaryLen });
        succeeded++;
      } catch (err) {
        results.push({ missionId, ok: false, error: err?.message || 'unknown' });
        failed++;
        // Continue — one bad mission shouldn't block the rest.
      }
    }

    logger.info('Admin bulk reanalyze complete', {
      adminEmail: req.user.email,
      totalStale: stale.length,
      succeeded,
      failed,
    });

    res.json({
      totalStale: stale.length,
      processed: stale.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    logger.error('Admin bulk reanalyze failed', { err: err.message });
    next(err);
  }
});

// -------------------------------------------------------------------------
// CRM lead management (P2 + P3)
// -------------------------------------------------------------------------

/**
 * POST /api/admin/crm — create a lead from the admin panel.
 */
router.post('/crm', async (req, res, next) => {
  try {
    const { name, email, company, stage = 'new_lead', notes } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const { data, error } = await supabase
      .from('crm_leads')
      .insert({ name, email, company, stage, notes, source: { channel: 'admin_panel' } })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/crm/export — CSV export of all leads.
 */
router.get('/crm/export', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('crm_leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const cols = ['id','name','email','company','stage','ltv_usd','health','notes','created_at','last_activity_at'];
    const header = cols.join(',');
    const rows = (data || []).map(r =>
      cols.map(c => JSON.stringify(r[c] ?? '')).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="crm_leads.csv"');
    res.send([header, ...rows].join('\n'));
  } catch (err) { next(err); }
});

// -------------------------------------------------------------------------
// Blog management (P4)
// -------------------------------------------------------------------------

/** GET /api/admin/blog — all posts (published + drafts) */
router.get('/blog', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('id,slug,title,excerpt,tag,emoji,published,published_at,created_at,views_count')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

/** POST /api/admin/blog — create a new post */
router.post('/blog', async (req, res, next) => {
  try {
    const { title, slug, excerpt, body_markdown, tag, emoji, cover_image_url, published } = req.body;
    if (!title || !slug) return res.status(400).json({ error: 'title and slug are required' });
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('blog_posts')
      .insert({
        title, slug, excerpt, body_markdown, tag, emoji, cover_image_url,
        published: published ?? false,
        published_at: published ? now : null,
        author_id: req.user.id,
        auto_generated: false,
      })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

/** PATCH /api/admin/blog/:id — update post fields */
router.patch('/blog/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, slug, excerpt, body_markdown, tag, emoji, cover_image_url, published } = req.body;
    const updates = { title, slug, excerpt, body_markdown, tag, emoji, cover_image_url, updated_at: new Date().toISOString() };
    if (published !== undefined) {
      updates.published = published;
      updates.published_at = published ? new Date().toISOString() : null;
    }
    // Strip undefined
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
    const { data, error } = await supabase
      .from('blog_posts').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/** DELETE /api/admin/blog/:id */
router.delete('/blog/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('blog_posts').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Promo Codes ──────────────────────────────────────────────────────────────

/** GET /api/admin/promos — list all promo codes */
router.get('/promos', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

/** POST /api/admin/promos — create a promo code */
router.post('/promos', async (req, res, next) => {
  try {
    const { code, type, value, description, active, max_uses, expires_at, sync_to_stripe } = req.body;
    if (!code || !type) return res.status(400).json({ error: 'code and type are required' });
    const validTypes = ['percentage', 'flat', 'free'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

    const normCode = code.toUpperCase().trim();

    // Pass 42 F2 — Sync to Stripe before inserting so we can store
    // the IDs on the row. Default sync_to_stripe=true; admin can opt
    // out for internal-only codes (VETT100, etc.).
    let stripeIds = { stripe_coupon_id: null, stripe_promotion_code_id: null };
    const shouldSync = sync_to_stripe !== false;
    if (shouldSync) {
      try {
        const synced = await createPromoOnStripe({
          code: normCode,
          type,
          value: Number(value || 0),
          description,
          max_uses,
          expires_at,
          active: active !== false,
        });
        stripeIds = {
          stripe_coupon_id: synced.coupon_id,
          stripe_promotion_code_id: synced.promotion_code_id,
        };
      } catch (stripeErr) {
        logger.error('Stripe promo sync failed', { code: normCode, err: stripeErr.message });
        // Don't insert a half-state row — fail fast so admin can retry.
        return res.status(502).json({
          error: 'stripe_sync_failed',
          message: stripeErr.message,
          hint: 'Verify STRIPE_SECRET_KEY env var on Railway, or set sync_to_stripe=false to skip.',
        });
      }
    }

    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        code: normCode,
        type,
        value: Number(value || 0),
        description: description || null,
        active: active !== false,
        max_uses: max_uses || null,
        expires_at: expires_at || null,
        sync_to_stripe: shouldSync,
        stripe_coupon_id: stripeIds.stripe_coupon_id,
        stripe_promotion_code_id: stripeIds.stripe_promotion_code_id,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

/** PATCH /api/admin/promos/:code — update a promo code */
router.patch('/promos/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const updates = {};
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.active      !== undefined) updates.active      = req.body.active;
    if (req.body.max_uses    !== undefined) updates.max_uses    = req.body.max_uses;
    if (req.body.expires_at  !== undefined) updates.expires_at  = req.body.expires_at;
    if (req.body.value       !== undefined) updates.value       = Number(req.body.value);
    if (req.body.type        !== undefined) updates.type        = req.body.type;

    // Pass 42 F2 — when toggling active, mirror to Stripe so the
    // promo code on customer-facing Checkout matches admin state.
    if (req.body.active !== undefined) {
      const { data: existing } = await supabase
        .from('promo_codes')
        .select('stripe_promotion_code_id, sync_to_stripe')
        .eq('code', code.toUpperCase())
        .single();
      if (existing?.sync_to_stripe && existing.stripe_promotion_code_id) {
        try {
          await updateStripePromoActive(existing.stripe_promotion_code_id, !!req.body.active);
        } catch (stripeErr) {
          logger.error('Stripe promo active-toggle failed', {
            code, err: stripeErr.message,
          });
          // Non-fatal: the DB update still proceeds. Surface in
          // response as a partial-success warning.
          updates._stripe_sync_warning = stripeErr.message;
        }
      }
    }

    // Strip the warning marker (not a real column).
    const stripeWarning = updates._stripe_sync_warning;
    delete updates._stripe_sync_warning;

    const { data, error } = await supabase
      .from('promo_codes')
      .update(updates)
      .eq('code', code.toUpperCase())
      .select()
      .single();
    if (error) throw error;
    res.json(stripeWarning ? { ...data, _stripe_sync_warning: stripeWarning } : data);
  } catch (err) { next(err); }
});

/** DELETE /api/admin/promos/:code — delete a promo code */
router.delete('/promos/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { error } = await supabase.from('promo_codes').delete().eq('code', code.toUpperCase());
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/revenue — revenue summary + daily buckets.
 * ?range=30d|month|quarter|all
 */
router.get('/revenue', async (req, res, next) => {
  try {
    const { start, end, days } = resolveRange(req.query.range || '30d');
    const priorStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

    const [missionsRes, priorMissionsRes, bucketsRes] = await Promise.all([
      supabase.from('missions')
        .select('total_price_usd, ai_cost_usd, status, goal_type, user_id')
        .in('status', ['paid', 'completed'])
        .gte('paid_at', start.toISOString())
        .lt('paid_at', end.toISOString()),
      supabase.from('missions')
        .select('total_price_usd')
        .in('status', ['paid', 'completed'])
        .gte('paid_at', priorStart.toISOString())
        .lt('paid_at', start.toISOString()),
      supabase.rpc('daily_revenue_buckets', { range_start: start, range_end: end }),
    ]);

    const curr = missionsRes.data      || [];
    const prev = priorMissionsRes.data || [];

    const currRevenue = curr.reduce((s, m) => s + Number(m.total_price_usd || 0), 0);
    const prevRevenue = prev.reduce((s, m) => s + Number(m.total_price_usd || 0), 0);
    const currCost    = curr.reduce((s, m) => s + Number(m.ai_cost_usd    || 0), 0);
    const currGross   = currRevenue - currCost;
    const avgOrder    = curr.length > 0 ? currRevenue / curr.length : 0;

    // Goal-type breakdown
    const goalBreakdown = {};
    for (const m of curr) {
      goalBreakdown[m.goal_type] = (goalBreakdown[m.goal_type] || 0) + Number(m.total_price_usd || 0);
    }

    res.json({
      period_days:    days,
      revenue:        { value: currRevenue, delta_pct: calcDelta(currRevenue, prevRevenue) },
      gross_profit:   { value: currGross,   delta_pct: 0 },
      avg_order:      { value: avgOrder,    delta_pct: 0 },
      mission_count:  curr.length,
      goal_breakdown: goalBreakdown,
      daily_buckets:  bucketsRes.data || [],
      last_updated:   new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/users/:id — full user profile + missions + notes + totals.
 */
router.get('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const [profileRes, missionsRes, notesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('missions')
        .select('id, status, goal_type, brief, total_price_usd, ai_cost_usd, respondent_count, created_at, paid_at, completed_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false }),
      supabase.from('admin_user_notes')
        .select('*')
        .eq('user_id', id)
        .order('created_at', { ascending: false }),
    ]);

    if (profileRes.error) return res.status(404).json({ error: 'User not found' });

    const missions = missionsRes.data || [];
    const paidMissions = missions.filter(m => ['paid', 'completed'].includes(m.status));
    const ltv = paidMissions.reduce((s, m) => s + Number(m.total_price_usd || 0), 0);

    res.json({
      profile:  profileRes.data,
      missions,
      notes:    notesRes.data || [],
      totals: {
        mission_count: missions.length,
        paid_count:    paidMissions.length,
        ltv_usd:       ltv,
        avg_order:     paidMissions.length > 0 ? ltv / paidMissions.length : 0,
      },
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/users/:id/notes — add a CRM note to a user.
 * Body: { content: string }
 */
router.post('/users/:id/notes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });

    const { data, error } = await supabase
      .from('admin_user_notes')
      .insert({ user_id: id, admin_id: req.user.id, content: content.trim() })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── AI Insights (in-process cache, 6-hour TTL) ────────────────────────────────

const _insightsCache = { data: null, generatedAt: null };
const INSIGHTS_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

async function _generateInsights(adminUserId) {
  const { callClaude, extractJSON } = require('../services/ai/anthropic');
  const now   = new Date();
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [summaryRes, funnelRes, segmentsRes] = await Promise.all([
    supabase.rpc('admin_ai_cost_summary', { range_start: since, range_end: now }),
    supabase.rpc('admin_funnel',          { range_start: since, range_end: now }),
    supabase.rpc('admin_user_segments'),
  ]);

  const contextData = {
    ai_costs: summaryRes.data,
    funnel:   funnelRes.data,
    segments: segmentsRes.data,
  };

  const response = await callClaude({
    callType:     'admin_insights',
    userId:       adminUserId,
    systemPrompt: `You are an expert product analytics advisor for VETT, an AI-powered consumer research platform. Analyze platform data and provide concise, actionable business insights.`,
    messages: [{
      role: 'user',
      content: `Analyze this 30-day platform snapshot and return ONLY valid JSON (no prose, no markdown):
{
  "headline": "One sentence — the single most important thing happening on the platform right now",
  "insights": [
    { "type": "positive|negative|neutral|warning", "title": "Short title ≤8 words", "body": "2-3 sentences with specific numbers from the data.", "action": "Recommended next action, or null" }
  ],
  "opportunities": ["Short opportunity string with numbers where relevant"],
  "risks": ["Short risk string with numbers where relevant"]
}

Rules: max 5 insights, max 3 opportunities, max 3 risks. Be specific.

Data:
${JSON.stringify(contextData, null, 2)}`
    }],
    maxTokens: 1500,
  });

  return extractJSON(response.text);
}

/**
 * GET /api/admin/insights — cached Claude-generated platform insights (6h TTL).
 */
router.get('/insights', async (req, res, next) => {
  try {
    const now   = Date.now();
    const stale = !_insightsCache.data
      || !_insightsCache.generatedAt
      || (now - _insightsCache.generatedAt) > INSIGHTS_TTL_MS;

    if (stale) {
      _insightsCache.data        = await _generateInsights(req.user.id);
      _insightsCache.generatedAt = now;
    }

    res.json({
      ..._insightsCache.data,
      generated_at: new Date(_insightsCache.generatedAt).toISOString(),
      is_fresh:     !stale,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/insights/refresh — force regenerate insights now.
 */
router.post('/insights/refresh', async (req, res, next) => {
  try {
    _insightsCache.data        = await _generateInsights(req.user.id);
    _insightsCache.generatedAt = Date.now();

    res.json({
      ..._insightsCache.data,
      generated_at: new Date(_insightsCache.generatedAt).toISOString(),
      is_fresh:     true,
    });
  } catch (err) { next(err); }
});

/**
 * Pass 22 Bug 22.2 — GET /api/admin/micro-funnel?range=30d|month|quarter|all
 *
 * Stage-to-stage funnel counts. Each count is DISTINCT user_id (or session_id
 * for landing_view, since most landing_views are anon). The frontend renders
 * adjacent transitions with conversion %.
 */
router.get('/micro-funnel', async (req, res, next) => {
  try {
    const { start, end } = resolveRange(req.query.range || '30d');
    const { data, error } = await supabase.rpc('admin_micro_funnel', {
      range_start: start, range_end: end,
    });
    if (error) throw error;
    res.json({ ...(data || {}), window: { since: start, until: end } });
  } catch (err) { next(err); }
});

/**
 * Pass 22 Bug 22.3 — GET /api/admin/session-funnel?range=30d|month|quarter|all
 *
 * Of distinct landing_view sessions in the window, what % later signed up?
 * This is the only way to compute landing → signup conversion since
 * landing_view is anon (no user_id correlation possible without session_id).
 */
router.get('/session-funnel', async (req, res, next) => {
  try {
    const { start, end } = resolveRange(req.query.range || '30d');
    const { data, error } = await supabase.rpc('admin_session_funnel', {
      range_start: start, range_end: end,
    });
    if (error) throw error;
    res.json({ ...(data || {}), window: { since: start, until: end } });
  } catch (err) { next(err); }
});

/**
 * Pass 22 Bug 22.9 — GET /api/admin/payment-errors
 *
 * Admin viewer for the payment_errors table. Returns the most recent rows,
 * filterable by date range, mission_id, error_code, and stage. Backend uses
 * the service-role singleton (set up by Bug 22.6 lockdown) so RLS is
 * bypassed and we read every row regardless of which user owned the failure.
 *
 * Query params (all optional):
 *   limit       1-500, default 100
 *   stage       client_*, create_intent, confirm, webhook_payment_failed
 *   missionId   uuid filter
 *   errorCode   exact match (e.g. 'card_declined')
 *   since       ISO timestamp lower bound (default: 30 days ago)
 *   until       ISO timestamp upper bound (default: now)
 *
 * Response: { rows, count, summary: { byStage, byErrorCode } }.
 * The summary block lets the admin UI render group-by-stage/group-by-code
 * sparklines without a second roundtrip.
 */
router.get('/payment-errors', async (req, res, next) => {
  try {
    const limit     = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const stage     = req.query.stage     || null;
    const missionId = req.query.missionId || null;
    const errorCode = req.query.errorCode || null;
    const sinceTs   = req.query.since
      ? new Date(req.query.since).toISOString()
      : new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const untilTs   = req.query.until
      ? new Date(req.query.until).toISOString()
      : new Date().toISOString();

    let q = supabase
      .from('payment_errors')
      .select('*')
      .gte('created_at', sinceTs)
      .lte('created_at', untilTs)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (stage)     q = q.eq('stage_at_failure', stage);
    if (missionId) q = q.eq('mission_id', missionId);
    if (errorCode) q = q.eq('error_code', errorCode);

    const { data: rows, error } = await q;
    if (error) throw error;

    // In-process aggregation. Cheap given limit=100; for larger windows we'd
    // push this to a SECURITY DEFINER aggregate RPC, but the admin viewer is
    // a low-traffic surface and the row count is bounded.
    const byStage = {};
    const byErrorCode = {};
    for (const r of rows || []) {
      const s = r.stage_at_failure || 'unknown';
      const c = r.error_code       || 'unknown';
      byStage[s]     = (byStage[s]     || 0) + 1;
      byErrorCode[c] = (byErrorCode[c] || 0) + 1;
    }

    res.json({
      rows: rows || [],
      count: (rows || []).length,
      window: { since: sinceTs, until: untilTs },
      summary: { byStage, byErrorCode },
    });
  } catch (err) { next(err); }
});

/**
 * Pass 43 T3a — POST /api/admin/backfill/chart-data
 *
 * Triggers the chart_data backfill across all completed missions
 * without chart_data. Responds 202 immediately and runs async so the
 * admin UI doesn't block. Logs an admin_actions row on start AND on
 * completion (with counts). Idempotent — safe to call repeatedly.
 *
 * Replaces the need to run scripts/backfill-chart-data.js via Railway
 * CLI (which isn't always available). One authenticated POST does it.
 */
router.post('/backfill/chart-data', async (req, res, next) => {
  try {
    const { runChartDataBackfill } = require('../services/backfills/chartData');

    // Count candidates up front for the response.
    const { data: completed, error: countErr } = await supabase
      .from('missions')
      .select('id, insights')
      .eq('status', 'completed');
    if (countErr) return next(countErr);
    const pending = (completed || []).filter((m) => {
      const cd = m.insights?.chart_data;
      return !cd || typeof cd !== 'object' || Object.keys(cd).length === 0;
    }).length;

    // Audit: start.
    await supabase.from('admin_actions').insert({
      admin_user_id: req.user.id,
      action_type:   'backfill_chart_data',
      target_type:   'backfill',
      target_id:     req.user.id, // no single target; use admin id
      reason:        'admin-triggered chart_data backfill',
      metadata:      { phase: 'start', pending_count: pending },
    });

    // Respond immediately; run async.
    res.status(202).json({ started: true, pending_count: pending });

    // Fire-and-forget (after response). Errors are logged + audited.
    (async () => {
      try {
        const result = await runChartDataBackfill(supabase, {
          onProgress: (done, total) =>
            logger.info('[admin backfill chart_data] progress', { done, total }),
        });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_chart_data',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered chart_data backfill',
          metadata:      { phase: 'complete', ...result },
        });
        logger.info('[admin backfill chart_data] done', result);
      } catch (bgErr) {
        logger.error('[admin backfill chart_data] failed', { err: bgErr.message });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_chart_data',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered chart_data backfill',
          metadata:      { phase: 'error', error: bgErr.message },
        }).catch(() => {});
      }
    })();
  } catch (err) { next(err); }
});

/**
 * Pass 46 Phase 3 — POST /api/admin/backfill/analysis
 *
 * Populates missions.analysis (deterministic methodology analysis)
 * for every completed mission where it's NULL. Same async-202 +
 * admin_actions audit pattern. Idempotent.
 */
router.post('/backfill/analysis', async (req, res, next) => {
  try {
    const { runAnalysisBackfill } = require('../services/backfills/analysis');

    const { data: completed, error: countErr } = await supabase
      .from('missions')
      .select('id, analysis')
      .eq('status', 'completed');
    if (countErr) return next(countErr);
    const pending = (completed || []).filter((m) => !m.analysis).length;

    await supabase.from('admin_actions').insert({
      admin_user_id: req.user.id,
      action_type:   'backfill_analysis',
      target_type:   'backfill',
      target_id:     req.user.id,
      reason:        'admin-triggered methodology analysis backfill',
      metadata:      { phase: 'start', pending_count: pending },
    });

    res.status(202).json({ started: true, pending_count: pending });

    (async () => {
      try {
        const result = await runAnalysisBackfill(supabase, {
          onProgress: (done, total) =>
            logger.info('[admin backfill analysis] progress', { done, total }),
        });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_analysis',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered methodology analysis backfill',
          metadata:      { phase: 'complete', ...result },
        });
      } catch (err) {
        logger.error('[admin backfill analysis] failed', { err: err.message });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_analysis',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered methodology analysis backfill',
          metadata:      { phase: 'failed', error: err.message },
        }).then(() => {}, () => {});
      }
    })();
  } catch (err) { next(err); }
});

/**
 * Pass 45 T1c — POST /api/admin/backfill/aggregations
 *
 * Populates missions.aggregated_by_question for every completed
 * mission where it's NULL. Same async-202 + admin_actions audit
 * pattern as the chart-data backfill. Idempotent.
 */
router.post('/backfill/aggregations', async (req, res, next) => {
  try {
    const { runAggregationsBackfill } = require('../services/backfills/aggregations');

    const { data: completed, error: countErr } = await supabase
      .from('missions')
      .select('id, aggregated_by_question')
      .eq('status', 'completed');
    if (countErr) return next(countErr);
    const pending = (completed || []).filter((m) => {
      const a = m.aggregated_by_question;
      return !a || typeof a !== 'object' || Object.keys(a).length === 0;
    }).length;

    await supabase.from('admin_actions').insert({
      admin_user_id: req.user.id,
      action_type:   'backfill_aggregations',
      target_type:   'backfill',
      target_id:     req.user.id,
      reason:        'admin-triggered aggregated_by_question backfill',
      metadata:      { phase: 'start', pending_count: pending },
    });

    res.status(202).json({ started: true, pending_count: pending });

    (async () => {
      try {
        const result = await runAggregationsBackfill(supabase, {
          onProgress: (done, total) =>
            logger.info('[admin backfill aggregations] progress', { done, total }),
        });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_aggregations',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered aggregated_by_question backfill',
          metadata:      { phase: 'complete', ...result },
        });
      } catch (err) {
        logger.error('[admin backfill aggregations] failed', { err: err.message });
        await supabase.from('admin_actions').insert({
          admin_user_id: req.user.id,
          action_type:   'backfill_aggregations',
          target_type:   'backfill',
          target_id:     req.user.id,
          reason:        'admin-triggered aggregated_by_question backfill',
          metadata:      { phase: 'failed', error: err.message },
        }).then(() => {}, () => {});
      }
    })();
  } catch (err) { next(err); }
});

/**
 * Pass 43 T3b — POST /api/admin/backfill/stripe-coupons
 *
 * Syncs every promo_codes row with sync_to_stripe=true AND
 * stripe_coupon_id IS NULL to Stripe (coupon + promotion code),
 * storing the IDs back. VETT100 is forced to sync_to_stripe=false
 * (internal-only, must NEVER reach Stripe). Synchronous (small set);
 * responds with per-code results.
 *
 * Requires STRIPE_SECRET_KEY. Idempotent — already-synced rows skip.
 */
router.post('/backfill/stripe-coupons', async (req, res, next) => {
  try {
    const { createPromoOnStripe } = require('../services/stripe');

    // Force VETT100 internal-only before syncing anything else.
    await supabase
      .from('promo_codes')
      .update({ sync_to_stripe: false })
      .eq('code', 'VETT100');

    const { data: rows, error } = await supabase
      .from('promo_codes')
      .select('code, type, value, description, active, max_uses, expires_at, sync_to_stripe, stripe_coupon_id');
    if (error) return next(error);

    const candidates = (rows || []).filter(
      (r) => r.sync_to_stripe === true && !r.stripe_coupon_id && r.code !== 'VETT100',
    );

    const results = [];
    for (const row of candidates) {
      try {
        const { coupon_id, promotion_code_id } = await createPromoOnStripe({
          code: row.code,
          type: row.type,
          value: row.value,
          description: row.description,
          max_uses: row.max_uses,
          expires_at: row.expires_at,
          active: row.active,
        });
        const { error: updErr } = await supabase
          .from('promo_codes')
          .update({ stripe_coupon_id: coupon_id, stripe_promotion_code_id: promotion_code_id })
          .eq('code', row.code);
        if (updErr) {
          results.push({ code: row.code, ok: false, error: updErr.message });
        } else {
          results.push({ code: row.code, ok: true, coupon_id, promotion_code_id });
        }
      } catch (stripeErr) {
        results.push({ code: row.code, ok: false, error: stripeErr.message });
      }
    }

    // Audit.
    await supabase.from('admin_actions').insert({
      admin_user_id: req.user.id,
      action_type:   'backfill_stripe_coupons',
      target_type:   'backfill',
      target_id:     req.user.id,
      reason:        'admin-triggered Stripe coupon backfill',
      metadata:      { candidates: candidates.length, results },
    });

    const succeeded = results.filter((r) => r.ok).length;
    logger.info('[admin backfill stripe-coupons] done', { candidates: candidates.length, succeeded });
    res.json({
      candidates: candidates.length,
      succeeded,
      vett100_forced_internal: true,
      results,
    });
  } catch (err) { next(err); }
});

module.exports = router;
