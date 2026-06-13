/**
 * Pass 47 — THE INVARIANT that stops the Pass-46 class of bug recurring.
 *
 * Every question `type` any generator can emit MUST have a simulator
 * handler (an explicit answer-format instruction) AND therefore appear
 * in simulate.js's SUPPORTED_QUESTION_TYPES. This test introspects the
 * generator source (claudeAI.js) for every `type` literal it tells the
 * model to emit and fails if any is unsupported — so adding a new
 * specialized question type without teaching the simulator to answer it
 * is caught here, not by a human visual audit of broken result pages.
 */

const fs = require('fs');
const path = require('path');
const { SUPPORTED_QUESTION_TYPES } = require('../src/services/ai/simulate');

// Tokens that appear in a `type:`-shaped position in prompt text but are
// NOT question types the persona answers (kano sub-form metadata, etc.).
const NON_QUESTION_TYPE_TOKENS = new Set(['functional', 'dysfunctional']);

function extractEmittedTypes(source) {
  const types = new Set();
  // Match "type": "x"  and  type: 'x'  and union forms "type": "a|b|c".
  const re = /\btype\s*[:=]\s*["']([a-z_|]+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const t of m[1].split('|')) {
      const tok = t.trim();
      if (tok && !NON_QUESTION_TYPE_TOKENS.has(tok)) types.add(tok);
    }
  }
  return types;
}

test('every generator-emitted question type has a simulator handler', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/claudeAI.js'), 'utf8',
  );
  const emitted = extractEmittedTypes(src);
  // Sanity: the scan must find the known core types, else the regex broke.
  for (const core of ['single', 'rating', 'text', 'multi', 'max_diff_set']) {
    expect(emitted.has(core)).toBe(true);
  }
  const unsupported = [...emitted].filter((t) => !SUPPORTED_QUESTION_TYPES.includes(t));
  expect(unsupported).toEqual([]); // any new emitted type must be taught to the simulator
});

test('SUPPORTED_QUESTION_TYPES includes the specialized types the analysis modules consume', () => {
  // max_diff_set is the Pass-47 addition the roadmap module parses as {best,worst}.
  expect(SUPPORTED_QUESTION_TYPES).toEqual(expect.arrayContaining(['max_diff_set']));
});
