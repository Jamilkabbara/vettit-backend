/**
 * Pass 49 — GET /api/blog/:slug must not serve unpublished posts.
 *
 * THE DEFECT
 * ----------
 * The single-post route did `.select('*').eq('slug', …).single()` with NO
 * published gate, on the SERVICE-KEY client (src/db/supabase.js), which
 * BYPASSES RLS. The row-level policies that protect this table everywhere
 * else are:
 *
 *   blog_posts_anon_published_read   USING (published = true)
 *   blog_posts_authenticated_full    USING (published = true OR author_id = …)
 *
 * so anyone who guessed or was told a slug read the full row, body_markdown
 * included. Not exploitable when written (all 3 production rows were
 * published), but the planned case-study flow is draft -> human edit ->
 * publish, and a draft case study is exactly the object that holds
 * un-redacted customer material.
 *
 * `published` is the authoritative gate, not `published_at`: NOT NULL
 * DEFAULT false (fail-closed) and the exact column both RLS policies test.
 * `published_at` is nullable with no default, so a draft carrying a
 * scheduled date passes an IS NOT NULL check while still being a draft —
 * which is what the LIST route used to test.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const ROWS = [
  { id: 'p1', slug: 'live-post', title: 'Live', excerpt: 'e', body_markdown: '# body',
    tag: 'Pricing', emoji: '💰', cover_image_url: null, published_at: '2026-05-01T00:00:00Z',
    views_count: 7, published: true,
    author_id: 'u-1', source_mission_ids: ['m-secret'], auto_generated: false,
    created_at: 'x', updated_at: 'y' },
  // The dangerous shape: a draft that HAS a published_at (scheduled) but is
  // not published. Passes `published_at IS NOT NULL`, fails `published`.
  { id: 'p2', slug: 'secret-case-study', title: 'Draft', excerpt: 'e', body_markdown: '# UNRELEASED customer material',
    tag: 'Case Study', emoji: '📊', cover_image_url: null, published_at: '2026-09-01T00:00:00Z',
    views_count: 0, published: false,
    author_id: 'u-1', source_mission_ids: ['m-customer'], auto_generated: true,
    created_at: 'x', updated_at: 'y' },
];

const updates = [];

jest.mock('../src/db/supabase', () => {
  const build = () => {
    const st = { cols: null, eqs: {}, notNullCols: [], isUpdate: false, patch: null };
    const chain = {
      select(cols) { st.cols = cols; return chain; },
      eq(col, val) { st.eqs[col] = val; return chain; },
      not(col) { st.notNullCols.push(col); return chain; },
      order() { return chain; },
      limit() { return chain; },
      update(patch) { st.isUpdate = true; st.patch = patch; return chain; },
      _rows() {
        let out = ROWS.slice();
        for (const [c, v] of Object.entries(st.eqs)) out = out.filter((r) => r[c] === v);
        for (const c of st.notNullCols) out = out.filter((r) => r[c] != null);
        // Honour the projection so a test can prove a column is not exposed.
        if (st.cols && st.cols !== '*') {
          const keep = st.cols.split(',').map((s) => s.trim());
          out = out.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]])));
        }
        return out;
      },
      async maybeSingle() { const r = chain._rows(); return { data: r[0] || null, error: null }; },
      async single() {
        const r = chain._rows();
        return r.length ? { data: r[0], error: null } : { data: null, error: { code: 'PGRST116' } };
      },
      then(res) {
        if (st.isUpdate) { updates.push({ eqs: st.eqs, patch: st.patch }); return Promise.resolve({ error: null }).then(res); }
        return Promise.resolve({ data: chain._rows(), error: null }).then(res);
      },
      catch() { return chain; },
    };
    return chain;
  };
  return { from: () => build() };
});

const express = require('express');
const request = require('supertest');
const blogRouter = require('../src/routes/blog');

function app() {
  const a = express();
  a.use('/api/blog', blogRouter);
  return a;
}

beforeEach(() => { updates.length = 0; });

// ── the leak ────────────────────────────────────────────────────────────
test('a PUBLISHED slug still returns 200 with its body', async () => {
  const r = await request(app()).get('/api/blog/live-post');
  expect(r.status).toBe(200);
  expect(r.body.slug).toBe('live-post');
  expect(r.body.body_markdown).toBe('# body');
});

test('an UNPUBLISHED slug returns 404 and never leaks the body', async () => {
  const r = await request(app()).get('/api/blog/secret-case-study');
  expect(r.status).toBe(404);
  expect(JSON.stringify(r.body)).not.toContain('UNRELEASED');
  expect(r.body.body_markdown).toBeUndefined();
});

test('unpublished and unknown slugs are INDISTINGUISHABLE', async () => {
  const unpub = await request(app()).get('/api/blog/secret-case-study');
  const unknown = await request(app()).get('/api/blog/no-such-post-at-all');
  expect(unpub.status).toBe(unknown.status);
  expect(unpub.body).toEqual(unknown.body);
});

// ── the counter oracle ──────────────────────────────────────────────────
test('an unpublished request does NOT bump views_count', async () => {
  await request(app()).get('/api/blog/secret-case-study');
  expect(updates).toHaveLength(0);
});

test('a published request DOES bump views_count, scoped to published rows', async () => {
  await request(app()).get('/api/blog/live-post');
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.views_count).toBe(8);
  expect(updates[0].eqs.published).toBe(true);
});

// ── the projection ──────────────────────────────────────────────────────
test('never returns internal columns - source_mission_ids above all', async () => {
  const r = await request(app()).get('/api/blog/live-post');
  for (const k of ['source_mission_ids', 'author_id', 'auto_generated', 'published', 'created_at', 'updated_at']) {
    expect(r.body[k]).toBeUndefined();
  }
  // source_mission_ids is the case-study provenance trail: it names which
  // customer missions a post was built from.
  expect(JSON.stringify(r.body)).not.toContain('m-secret');
});

// ── the list route ──────────────────────────────────────────────────────
test('the list route gates on `published`, not the weaker `published_at`', async () => {
  const r = await request(app()).get('/api/blog');
  expect(r.status).toBe(200);
  const slugs = r.body.map((p) => p.slug);
  expect(slugs).toContain('live-post');
  // p2 HAS a published_at, so an IS NOT NULL gate would have listed it.
  expect(slugs).not.toContain('secret-case-study');
});

test('the list route never exposes body_markdown', async () => {
  const r = await request(app()).get('/api/blog');
  for (const p of r.body) expect(p.body_markdown).toBeUndefined();
});
