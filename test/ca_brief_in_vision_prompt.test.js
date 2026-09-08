/**
 * The Creative Attention brief reaches the vision model.
 *
 * CreativeAttentionPage collects a free-text campaign brief on the same screen
 * as brand, audience, desired emotions and key message. Four of those five
 * were interpolated into both vision prompts. `brief` was not: it was written
 * to the mission row and never read by creativeAttention.js, so the customer
 * filled in a field the analysis could not see.
 *
 * Verified by a sweep of every field the CA page writes against what the
 * analysis reads. Only two were collected and discarded: `brief` (fixed here)
 * and `tier` (an audit-trail stamp with no reader anywhere in src/, left
 * alone deliberately since it is billing metadata, not analysis context).
 *
 * Both prompts matter and are asserted separately. The per-frame prompt drives
 * each frame's audience_resonance; the synthesis prompt drives the composite,
 * where resonance carries 0.15 weight. A brief in only one of them would score
 * frames against context the summary never saw.
 *
 * Source-level assertions, because reaching the prompt otherwise means calling
 * the Anthropic vision API.
 */
const { readFileSync } = require('node:fs');
const SRC = readFileSync(require.resolve('../src/services/ai/creativeAttention'), 'utf8');

/** The template literal for each prompt, so assertions cannot bleed across. */
function promptBodies(src) {
  const bodies = [];
  const re = /const prompt = `([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src)) !== null) bodies.push(m[1]);
  return bodies;
}

describe('the campaign brief is passed as vision context', () => {
  const prompts = promptBodies(SRC);

  test('both vision prompts were found', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });

  test('every vision prompt interpolates mission.brief', () => {
    for (const p of prompts) expect(p).toMatch(/\$\{mission\.brief\b/);
  });

  test('the brief sits with the other four context fields, not appended elsewhere', () => {
    for (const p of prompts) {
      for (const field of ['brand_name', 'target_audience', 'desired_emotions', 'key_message']) {
        expect(p).toMatch(new RegExp(`mission\\.${field}\\b`));
      }
      // Ordered: brief must come after audience and before emotions, so the
      // model reads it as campaign context rather than a trailing afterthought.
      expect(p.indexOf('mission.brief')).toBeGreaterThan(p.indexOf('mission.target_audience'));
      expect(p.indexOf('mission.brief')).toBeLessThan(p.indexOf('mission.desired_emotions'));
    }
  });
});

describe('the two prompts frame a missing value identically', () => {
  test("target_audience falls back to the same string in both", () => {
    const prompts = promptBodies(SRC);
    const fallbacks = prompts.map((p) => {
      const m = p.match(/mission\.target_audience \|\| '([^']*)'/);
      return m && m[1];
    }).filter(Boolean);
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fallbacks).size).toBe(1);
  });

  test("the frame prompt no longer says 'general consumers' while synthesis says 'general'", () => {
    // The exact drift this replaced: same input, two different framings, so a
    // mission with no audience was analysed against 'general consumers' per
    // frame and summarised against 'general'.
    expect(SRC).not.toContain("target_audience || 'general consumers'");
    expect(SRC).not.toContain("target_audience || 'general'");
  });

  test('brief falls back consistently too', () => {
    const prompts = promptBodies(SRC);
    const fallbacks = prompts.map((p) => {
      const m = p.match(/mission\.brief \|\| '([^']*)'/);
      return m && m[1];
    }).filter(Boolean);
    expect(new Set(fallbacks).size).toBe(1);
  });
});
