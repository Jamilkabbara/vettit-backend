/**
 * Every AI call name used anywhere in src/ must be routed to a model and
 * tagged with a spend purpose.
 *
 * WHY
 * ---
 * callClaude throws "Unknown AI callType" for a name missing from
 * MODEL_ROUTING. Three times a feature shipped calling a name nobody routed:
 * admin_insights (500 on every cache miss), and creative_attention_market_context
 * (#175), whose throw was caught and logged, so every Creative Attention
 * customer who chose a market silently got no market notes. The feature's own
 * tests mocked callClaude, so none of them could see it.
 *
 * This test does not mock anything. It reads the source, finds every call name,
 * and checks it against the real maps in src/services/ai/anthropic.js. A name
 * missing from CALL_TYPE_TO_PURPOSE does not throw, but its spend lands in
 * 'unknown_legacy', so that is required too.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const ANTHROPIC = path.join(SRC, 'services', 'ai', 'anthropic.js');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Keys of `const <name> = { ... }` in a source file, without executing it. */
function objectKeys(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) throw new Error(`could not find const ${name} = { ... }`);
  return new Set([...m[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((x) => x[1]));
}
/** Values of `const <name> = { key: 'value', ... }`. */
function objectStringValues(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) throw new Error(`could not find const ${name} = { ... }`);
  return [...m[1].matchAll(/:\s*'([a-z_]+)'/g)].map((x) => x[1]);
}

/**
 * Every `callType:` in src. A string literal is taken as is. A non-literal is
 * accepted only if it indexes a known lookup object whose values are then
 * checked; anything else fails, so a new dynamic pattern cannot slip past.
 */
function collectCallTypes(files) {
  const names = new Map();   // name -> [file:line]
  const unresolved = [];
  const add = (n, where) => names.set(n, [...(names.get(n) || []), where]);
  for (const file of files) {
    if (file === ANTHROPIC) continue;
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), file);
    src.split('\n').forEach((line, i) => {
      const m = line.match(/\bcallType\s*:\s*(.+?)\s*,?\s*(\/\/.*)?$/);
      if (!m || /^\s*(\*|\/\/)/.test(line)) return;
      const where = `${rel}:${i + 1}`;
      const expr = m[1].replace(/,.*$/, '').trim();
      const lit = expr.match(/^['"`]([a-z_]+)['"`]$/);
      if (lit) { add(lit[1], where); return; }
      const idx = expr.match(/^([A-Z_]+)\[[^\]]+\]$/);
      if (idx) { objectStringValues(src, idx[1]).forEach((v) => add(v, `${where} (${idx[1]})`)); return; }
      unresolved.push(`${where}: callType ${expr}`);
    });
  }
  return { names, unresolved };
}

describe('AI call names are all routed', () => {
  const anthropicSrc = fs.readFileSync(ANTHROPIC, 'utf8');
  const routed = objectKeys(anthropicSrc, 'MODEL_ROUTING');
  const purposed = objectKeys(anthropicSrc, 'CALL_TYPE_TO_PURPOSE');
  const { names, unresolved } = collectCallTypes(walk(SRC));

  test('the scan finds the call names it should (not vacuous)', () => {
    // Known call sites across the pipeline, chat and admin.
    for (const n of ['survey_gen', 'persona_gen', 'response_sim', 'chat_results', 'creative_attention_synthesis', 'creative_attention_market_context', 'admin_insights']) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.size).toBeGreaterThan(15);
  });

  test('every callType expression resolves to known names', () => {
    expect(unresolved).toEqual([]);
  });

  test('every call name is in MODEL_ROUTING (callClaude throws otherwise)', () => {
    const missing = [...names.keys()].filter((n) => !routed.has(n)).map((n) => `${n} <- ${names.get(n).join(', ')}`);
    expect(missing).toEqual([]);
  });

  test('every call name has a spend purpose (else it is logged as unknown_legacy)', () => {
    const missing = [...names.keys()].filter((n) => !purposed.has(n)).map((n) => `${n} <- ${names.get(n).join(', ')}`);
    expect(missing).toEqual([]);
  });

  test('the parsed map matches the live module', () => {
    const live = require(ANTHROPIC);
    expect(new Set(Object.keys(live.MODEL_ROUTING))).toEqual(routed);
  });
});
