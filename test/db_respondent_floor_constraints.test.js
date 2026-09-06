/**
 * Pass 51 Fix 1 — the respondent_count range and per-goal floors exist as DB
 * CHECK constraints, and they say the same thing the pricing engine says.
 *
 * WHY THIS TEST IS SHAPED LIKE THIS
 * There is no Postgres in the jest environment, so this cannot exercise a live
 * constraint. What it does instead is stronger than a substring match: it
 * lifts each CHECK predicate out of the migration, parses the small SQL subset
 * it is written in, and EVALUATES it under Postgres three-valued logic over a
 * table of mission rows - including the exact shapes that exist in production
 * today. A wrong comparison (`>` where `>=` belongs), a wrong number, a floor
 * attached to the wrong goal_type, or a missing NULL escape all fail here,
 * because the predicate is executed rather than read.
 *
 * The numbers are read from src/utils/pricingEngine.js, never typed in. If the
 * engine's floors move and the migration does not, this fails.
 */
const fs = require('fs');
const path = require('path');

const {
  MAX_SELF_SERVE_RESPONDENTS,
  BRAND_LIFT_MIN_RESPONDENTS,
  CA_MIN_RESPONDENTS,
  validateMissionPricing,
} = require('../src/utils/pricingEngine');

const MIGRATION = path.join(
  __dirname, '..', 'migrations', 'pass-51',
  '01_missions_respondent_count_floors_check.sql',
);

const RANGE_CHK = 'missions_respondent_count_range_chk';
const BL_CHK    = 'missions_brand_lift_respondent_floor_chk';
const CA_CHK    = 'missions_creative_attention_respondent_floor_chk';

// ── a very small SQL boolean-expression evaluator ───────────────────────────
// Grammar (all this migration needs, and all it is allowed to use - anything
// outside it throws, so the test fails loudly rather than passing blind):
//   expr       := term (OR term)*
//   term       := factor (AND factor)*
//   factor     := '(' expr ')' | comparison
//   comparison := column (IS NULL | IS NOT NULL | (>=|<=|<>|=|>|<) operand)
// Values are tri-state: true, false, or null (SQL UNKNOWN).

function tokenize(sql) {
  const cleaned = sql.replace(/--[^\n]*/g, ' ').replace(/::text/gi, '');
  const re = /\s*(\(|\)|>=|<=|<>|=|>|<|'[^']*'|-?\d+|[A-Za-z_][A-Za-z_0-9]*)/y;
  const toks = [];
  let i = 0;
  while (i < cleaned.length) {
    re.lastIndex = i;
    const m = re.exec(cleaned);
    if (!m) {
      if (/^\s+$/.test(cleaned.slice(i))) break;
      throw new Error(`unparseable SQL near: ${cleaned.slice(i, i + 40)}`);
    }
    toks.push(m[1]);
    i = re.lastIndex;
  }
  return toks;
}

const or3  = (a, b) => (a === true || b === true ? true : (a === null || b === null ? null : false));
const and3 = (a, b) => (a === false || b === false ? false : (a === null || b === null ? null : true));

function makeParser(tokens, row) {
  let pos = 0;
  const peek = () => tokens[pos];
  const up   = () => (tokens[pos] || '').toUpperCase();
  const take = () => tokens[pos++];
  const expect = (t) => {
    if ((tokens[pos] || '').toUpperCase() !== t) {
      throw new Error(`expected ${t}, got ${tokens[pos]}`);
    }
    return tokens[pos++];
  };

  const COLUMNS = new Set(['respondent_count', 'goal_type']);

  function operand() {
    const t = take();
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+$/.test(t)) return Number(t);
    throw new Error(`unexpected operand: ${t}`);
  }

  function comparison() {
    const col = take();
    if (!COLUMNS.has(col)) throw new Error(`unknown column: ${col}`);
    const left = row[col] === undefined ? null : row[col];

    if (up() === 'IS') {
      take();
      if (up() === 'NOT') { take(); expect('NULL'); return left !== null; }
      expect('NULL');
      return left === null;
    }
    const op = take();
    const right = operand();
    if (left === null || right === null) return null; // SQL UNKNOWN
    switch (op) {
      case '>=': return left >= right;
      case '<=': return left <= right;
      case '>':  return left > right;
      case '<':  return left < right;
      case '=':  return left === right;
      case '<>': return left !== right;
      default: throw new Error(`unknown operator: ${op}`);
    }
  }

  function factor() {
    if (peek() === '(') { take(); const v = expr(); expect(')'); return v; }
    return comparison();
  }
  function term() {
    let v = factor();
    while (up() === 'AND') { take(); v = and3(v, factor()); }
    return v;
  }
  function expr() {
    let v = term();
    while (up() === 'OR') { take(); v = or3(v, term()); }
    return v;
  }

  return () => {
    const v = expr();
    if (pos !== tokens.length) throw new Error(`trailing tokens: ${tokens.slice(pos).join(' ')}`);
    return v;
  };
}

/** Pull every `ADD CONSTRAINT <name> CHECK (<expr>) NOT VALID;` out of the file. */
function parseConstraints(sqlText) {
  const out = {};
  const re = /ADD CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*?)\)\s*NOT VALID\s*;/gi;
  let m;
  while ((m = re.exec(sqlText)) !== null) out[m[1]] = m[2];
  return out;
}

const sql = fs.readFileSync(MIGRATION, 'utf8');
const constraints = parseConstraints(sql);
const tokenSets = Object.fromEntries(
  Object.entries(constraints).map(([name, body]) => [name, tokenize(body)]),
);

/** A row is accepted only if EVERY constraint yields TRUE or UNKNOWN. */
function accepts(row) {
  return Object.values(tokenSets).every((toks) => makeParser(toks.slice(), row)() !== false);
}

const row = (goal_type, respondent_count) => ({ goal_type, respondent_count });

describe('the migration declares all three constraints, NOT VALID', () => {
  test('all three named constraints are present', () => {
    expect(Object.keys(constraints).sort()).toEqual([BL_CHK, CA_CHK, RANGE_CHK].sort());
  });

  test('each is added NOT VALID - 16 legacy rows would fail a validating add', () => {
    // Counted read-only against production while writing this migration:
    // 6 brand_lift under the floor, 10 creative_attention under the floor.
    // A plain ADD CONSTRAINT would abort on them and ship nothing.
    [RANGE_CHK, BL_CHK, CA_CHK].forEach((name) => {
      const decl = new RegExp(`ADD CONSTRAINT\\s+${name}\\s+CHECK[\\s\\S]*?NOT VALID\\s*;`, 'i');
      expect(sql).toMatch(decl);
    });
  });

  test('no VALIDATE CONSTRAINT is issued - it would fail on the legacy rows', () => {
    const live = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(live).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
  });

  test('no UPDATE runs - paid, completed studies are not rewritten', () => {
    const live = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(live).not.toMatch(/^\s*UPDATE\s+/im);
  });
});

describe('the constraints encode the pricing engine numbers, not copies of them', () => {
  const ints = (expr) => (expr.match(/\b\d+\b/g) || []).map(Number);

  test('range constraint uses MAX_SELF_SERVE_RESPONDENTS', () => {
    expect(ints(constraints[RANGE_CHK])).toContain(MAX_SELF_SERVE_RESPONDENTS);
  });
  test('brand_lift constraint uses BRAND_LIFT_MIN_RESPONDENTS', () => {
    expect(ints(constraints[BL_CHK])).toContain(BRAND_LIFT_MIN_RESPONDENTS);
  });
  test('creative_attention constraint uses CA_MIN_RESPONDENTS', () => {
    expect(ints(constraints[CA_CHK])).toContain(CA_MIN_RESPONDENTS);
  });
  test('each goal floor names only its own goal_type', () => {
    expect(constraints[BL_CHK]).toMatch(/'brand_lift'/);
    expect(constraints[BL_CHK]).not.toMatch(/'creative_attention'/);
    expect(constraints[CA_CHK]).toMatch(/'creative_attention'/);
    expect(constraints[CA_CHK]).not.toMatch(/'brand_lift'/);
  });
});

describe('predicates evaluated: rows the DB must ACCEPT', () => {
  test.each([
    ['validate at the minimum count',            row('validate', 1)],
    ['validate at the self-serve ceiling',       row('validate', MAX_SELF_SERVE_RESPONDENTS)],
    ['brand_lift exactly at its floor',          row('brand_lift', BRAND_LIFT_MIN_RESPONDENTS)],
    ['brand_lift above its floor',               row('brand_lift', 500)],
    ['creative_attention exactly at its floor',  row('creative_attention', CA_MIN_RESPONDENTS)],
    // A count below the brand_lift floor is perfectly legal on a goal with no
    // floor. Catches a constraint written without its goal_type guard.
    ['validate at a count no brand_lift may use', row('validate', 5)],
    ['creative_attention at a count no brand_lift may use', row('creative_attention', 50)],
    // Both columns are nullable; every predicate must escape on NULL.
    ['null respondent_count on a floored goal',  row('brand_lift', null)],
    ['null goal_type',                           row(null, 5)],
    ['both null',                                row(null, null)],
  ])('accepts %s', (_label, r) => {
    expect(accepts(r)).toBe(true);
  });
});

describe('predicates evaluated: rows the DB must REJECT', () => {
  test.each([
    ['zero respondents',                 row('validate', 0)],
    ['negative respondents',             row('validate', -1)],
    ['one over the self-serve ceiling',  row('validate', MAX_SELF_SERVE_RESPONDENTS + 1)],
    ['far over the ceiling',             row('brand_lift', 5000)],
    // Boundary: a `>` where `>=` belongs would wrongly reject the floor itself,
    // and these cases pin the comparison from both sides.
    ['brand_lift one under its floor',   row('brand_lift', BRAND_LIFT_MIN_RESPONDENTS - 1)],
    ['creative_attention one under its floor', row('creative_attention', CA_MIN_RESPONDENTS - 1)],
    // The exact shapes sitting in production today.
    ['brand_lift at 5 (a real legacy row)',  row('brand_lift', 5)],
    ['brand_lift at 20 (a real legacy row)', row('brand_lift', 20)],
    ['creative_attention at 1 (a real legacy row)', row('creative_attention', 1)],
  ])('rejects %s', (_label, r) => {
    expect(accepts(r)).toBe(false);
  });
});

describe('the DB constraints agree with validateMissionPricing', () => {
  // The engine is the source of truth for the floors; the constraint is the
  // layer the client-side Setup insert cannot route around. Where the engine
  // refuses a row on count alone, the DB must refuse it too, or the bypass
  // survives in exactly the place it already lives.
  test.each([
    ['brand_lift', BRAND_LIFT_MIN_RESPONDENTS - 1],
    ['brand_lift', 5],
    ['creative_attention', CA_MIN_RESPONDENTS - 1],
    ['validate', MAX_SELF_SERVE_RESPONDENTS + 1],
  ])('%s at n=%i is refused by both layers', (goalType, n) => {
    const engine = validateMissionPricing({ goalType, respondentCount: n, mediaType: 'image' });
    expect(engine.valid).toBe(false);
    expect(accepts(row(goalType, n))).toBe(false);
  });
});
