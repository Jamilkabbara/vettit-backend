const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { adminOnly } = require('../middleware/adminOnly');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

// All routes are gated: authenticate → adminOnly
router.use(authenticate, adminOnly);

/**
 * GET /api/admin/overview
 * Top-line KPIs + AI cost totals + funnel snapshot.
 */
router.get('/overview', async (req, res, next) => {
  try {
    // Totals
    const [{ count: userCount }, { count: missionCount }, { data: revenue }] = await Promise.all([
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('missions').select('*', { count: 'exact', head: true }),
      supabase.from('missions').select('total_price_usd, ai_cost_usd').eq('status', 'completed'),
    ]);

    const totalRevenue = (revenue || []).reduce((s, m) => s + Number(m.total_price_usd || 0), 0);
    const totalAiCost  = (revenue || []).reduce((s, m) => s + Number(m.ai_cost_usd || 0),    0);
    const grossMargin  = totalRevenue > 0 ? (totalRevenue - totalAiCost) / totalRevenue : 0;

    // Funnel
    const funnel = {};
    const statuses = ['draft', 'pending_payment', 'paid', 'processing', 'completed', 'failed'];
    for (const s of statuses) {
      const { count } = await supabase
        .from('missions').select('*', { count: 'exact', head: true }).eq('status', s);
      funnel[s] = count || 0;
    }

    res.json({
      userCount:    userCount || 0,
      missionCount: missionCount || 0,
      totalRevenue,
      totalAiCost,
      grossMargin,
      funnel,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/missions — all missions (paginated).
 */
router.get('/missions', async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/users — all user profiles.
 */
router.get('/users', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/ai-costs — per-operation + per-model breakdown.
 * ?missionId=<uuid> to scope to a single mission.
 */
router.get('/ai-costs', async (req, res, next) => {
  try {
    const { missionId, since } = req.query;
    let q = supabase.from('ai_calls').select('call_type, model, cost_usd, input_tokens, output_tokens, cached_tokens, success, created_at');
    if (missionId) q = q.eq('mission_id', missionId);
    if (since)     q = q.gte('created_at', since);
    const { data, error } = await q.limit(10000);
    if (error) throw error;

    const byType = {}, byModel = {};
    let totalCost = 0, totalCalls = 0, totalFailed = 0;
    for (const row of data || []) {
      totalCost += Number(row.cost_usd || 0);
      totalCalls++;
      if (!row.success) totalFailed++;

      byType[row.call_type] = byType[row.call_type] || { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
      byType[row.call_type].calls++;
      byType[row.call_type].cost += Number(row.cost_usd || 0);
      byType[row.call_type].tokensIn  += row.input_tokens || 0;
      byType[row.call_type].tokensOut += row.output_tokens || 0;

      byModel[row.model] = byModel[row.model] || { calls: 0, cost: 0 };
      byModel[row.model].calls++;
      byModel[row.model].cost += Number(row.cost_usd || 0);
    }

    res.json({ totalCost, totalCalls, totalFailed, byType, byModel });
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

module.exports = router;
