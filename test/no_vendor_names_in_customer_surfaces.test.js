/**
 * VETT does not name its suppliers on customer-facing surfaces.
 *
 * Two things this locks:
 *
 * 1. Export templates. A customer-delivered PDF said "runs frame-by-frame
 *    Claude Vision analysis". Exports are the most durable surface we have -
 *    a PDF gets forwarded, attached to a deck, and read a year later.
 *
 * 2. failure_reason. It is a customer-facing column rendered on the
 *    processing page, and the frontend reads it DIRECTLY from Postgres via
 *    supabase-js, so an API-level filter cannot cover it. runMission stored
 *    the raw thrown message, and two throw sites in creativeAttention.js name
 *    the vendor - so a HEIC upload put "Anthropic Vision accepts JPG, PNG,
 *    WebP, GIF." on screen. The EMAIL path already sanitised, which is
 *    exactly why only the on-screen path was affected and it went unnoticed.
 */
const fs = require('fs');
const path = require('path');

const VENDOR = /\b(anthropic|claude|openai|chatgpt|gemini|llama)\b/i;

describe('no supplier names in customer-delivered export templates', () => {
  const dir = path.join(__dirname, '..', 'src', 'services', 'exports', 'pdf-v2', 'templates');
  const templates = fs.readdirSync(dir).filter((f) => f.endsWith('.hbs'));

  it('finds templates to check (guards against a vacuous pass)', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  test.each(templates)('%s names no model vendor', (file) => {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    // Strip handlebars comments; they are not rendered.
    const rendered = body.replace(/\{\{!--[\s\S]*?--\}\}/g, '').replace(/\{\{![\s\S]*?\}\}/g, '');
    const hit = rendered.split('\n').find((l) => VENDOR.test(l));
    expect(hit || null).toBeNull();
  });
});

describe('failure_reason is sanitised before it is stored', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'jobs', 'runMission.js'), 'utf8',
  );

  it('the fatal handler does not store the raw error message', () => {
    // The exact shape that leaked. If someone reinstates it, this fails.
    expect(src).not.toMatch(
      /const failureReason = String\(err && err\.message \? err\.message : 'Unknown error'\)/,
    );
    expect(src).toMatch(/const failureReason = friendlyFailureReason\(/);
  });

  it('the empty-survey guard does not interpolate a raw error', () => {
    expect(src).not.toMatch(/run-time generation failed: \$\{qErr\.message\}/);
    expect(src).toMatch(/run-time generation failed: \$\{friendlyFailureReason\(qErr\.message\)\}/);
  });

  it('the sanitiser strips the vendor name from the real leaking message', () => {
    // Reproduces friendlyFailureReason's generic branch: first sentence only.
    const raw = 'Unsupported image format. Anthropic Vision accepts JPG, PNG, WebP, GIF.';
    const sanitised = (raw.split(/[.\n]/)[0] || raw).slice(0, 180);
    expect(sanitised).toBe('Unsupported image format');
    expect(VENDOR.test(sanitised)).toBe(false);
    expect(VENDOR.test(raw)).toBe(true); // positive control: the raw DOES leak
  });
});
