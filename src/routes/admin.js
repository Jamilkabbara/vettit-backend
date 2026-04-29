const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const supabase = require('../db/supabase'); // service-role client for all admin queries (RPC + tables)
const logger = require('../utils/logger');

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
      segments:         segments.data,
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

    let q = supabase
      .from('missions')
      .select(
        `id, user_id, status, goal_type, brief, total_price_usd, ai_cost_usd,
         respondent_count, target_countries, promo_code, promo_discount_usd,
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

    const enriched = (data || []).map(m => ({
      ...m,
      user:       profileMap[m.user_id] || null,
      margin_usd: Number(m.total_price_usd || 0) - Number(m.ai_cost_usd || 0),
    }));

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

    if (search) q = q.or(`full_name.ilike.%${search}%,company_name.ilike.%${search}%`);

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

    const [summary, priorSummary, byOperation, modelMix, margins, buckets] = await Promise.all([
      supabase.rpc('admin_ai_cost_summary',      { range_start: start,      range_end: end }),
      supabase.rpc('admin_ai_cost_summary',      { range_start: priorStart, range_end: start }),
      supabase.rpc('admin_ai_cost_by_operation', { range_start: start,      range_end: end }),
      supabase.rpc('admin_ai_model_mix',         { range_start: start,      range_end: end }),
      supabase.rpc('admin_mission_margins',      { range_start: start,      range_end: end }),
      supabase.rpc('daily_revenue_buckets',      { range_start: start,      range_end: end }),
    ]);

    const s  = summary.data      || {};
    const ps = priorSummary.data || {};

    res.json({
      summary: {
        total_cost_usd:       { value: s.total_cost_usd,       delta_pct: calcDelta(s.total_cost_usd,       ps.total_cost_usd)       },
        total_revenue_usd:    { value: s.total_revenue_usd,    delta_pct: calcDelta(s.total_revenue_usd,    ps.total_revenue_usd)    },
        gross_margin_pct:     { value: s.gross_margin_pct,     delta_pct: calcDelta(s.gross_margin_pct,     ps.gross_margin_pct)     },
        total_calls:          { value: s.total_calls,          delta_pct: calcDelta(s.total_calls,          ps.total_calls)          },
        avg_cost_per_mission: { value: s.avg_cost_per_mission, delta_pct: 0 },
        tiering_savings_usd:  s.tiering_savings_usd || 0,
      },
      by_operation:    byOperation.data || [],
      model_mix:       modelMix.data    || [],
      mission_margins: margins.data     || [],
      daily_buckets:   buckets.data     || [],
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
    const { code, type, value, description, active, max_uses, expires_at } = req.body;
    if (!code || !type) return res.status(400).json({ error: 'code and type are required' });
    const validTypes = ['percentage', 'flat', 'free'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        code: code.toUpperCase().trim(),
        type,
        value: Number(value || 0),
        description: description || null,
        active: active !== false,
        max_uses: max_uses || null,
        expires_at: expires_at || null,
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

    const { data, error } = await supabase
      .from('promo_codes')
      .update(updates)
      .eq('code', code.toUpperCase())
      .select()
      .single();
    if (error) throw error;
    res.json(data);
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

module.exports = router;
