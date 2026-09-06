/**
 * Pass 51 Fix 2 - ensure_recruitment_columns() recomputes on UPDATE.
 *
 * THE DEFECT, RESTATED
 * The Pass 43 trigger fires BEFORE INSERT OR UPDATE OF (respondent_count,
 * total_price_usd), and both its header and the commit that shipped it say the
 * UPDATE branch exists so that "when checkout writes total_price_usd, the
 * UPDATE-OF branch fires and recomputes the authoritative ceiling". It never
 * did, because every assignment was guarded on its own TARGET column still
 * being NULL - and by checkout time the ceiling is already set from the
 * estimated price. The guard on the source column (do not derive from a NULL
 * or zero price) is fine and stays. The guard on the target column is the bug.
 *
 * WHAT THIS TEST DOES
 * No Postgres in jest, so it parses the plpgsql body and checks the property
 * that actually distinguishes fixed from broken: inside the UPDATE branch, no
 * assignment to a column may sit under an IF whose condition tests that same
 * column for NULL. It is a structural claim about the guard, not a substring
 * match on the fix - reinstating the old guard in any spelling fails it.
 *
 * It also pins the INSERT branch, where those same guards are CORRECT and must
 * survive: an insert must not overwrite a value the app supplied.
 */
const fs = require('fs');
const path = require('path');

const NEW_MIGRATION = path.join(
  __dirname, '..', 'migrations', 'pass-51',
  '02_ensure_recruitment_columns_update_recompute.sql',
);
const PASS43_MIGRATION = path.join(
  __dirname, '..', 'migrations', 'pass-43', '01_a1_column_trigger.sql',
);

const DERIVED = ['target_qualified_count', 'ai_spend_ceiling_usd'];

/** Strip comments and lift the plpgsql body out of the $$ ... $$ block. */
function functionBody(file) {
  const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
  const m = sql.match(/RETURNS trigger AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql/i);
  if (!m) throw new Error(`no plpgsql body found in ${path.basename(file)}`);
  return m[1];
}

/**
 * Split the body into its INSERT branch and its UPDATE branch on the
 * `IF TG_OP = 'INSERT' THEN ... ELSE ... END IF;` that the fix introduces.
 */
function branches(body) {
  const open = body.match(/IF\s+TG_OP\s*=\s*'INSERT'\s+THEN/i);
  if (!open) throw new Error('function is not split by TG_OP - the UPDATE path is not distinguishable');
  const start = open.index + open[0].length;

  // Walk the IF / ELSE / END IF structure with a depth counter so nested
  // guards inside a branch are not mistaken for the branch's own terminator.
  const re = /\bEND\s+IF\b|\bELSIF\b|\bELSE\b|\bIF\b/gi;
  re.lastIndex = start;
  let depth = 0, elseAt = -1, m;
  while ((m = re.exec(body)) !== null) {
    const tok = m[0].toUpperCase().replace(/\s+/g, ' ');
    if (tok === 'IF') { depth += 1; continue; }
    if (tok === 'END IF') {
      if (depth === 0) {
        if (elseAt < 0) throw new Error('TG_OP block has no ELSE - there is no UPDATE branch');
        return { insert: body.slice(start, elseAt), update: body.slice(elseAt + 4, m.index) };
      }
      depth -= 1;
      continue;
    }
    if (depth === 0 && tok === 'ELSE') elseAt = m.index;
  }
  throw new Error('unterminated TG_OP block');
}

/**
 * Every `IF <cond> THEN <block> END IF;` in a chunk, non-nested (the branch
 * bodies here are flat).
 */
function ifBlocks(chunk) {
  const out = [];
  const re = /IF\s+([\s\S]*?)\s+THEN([\s\S]*?)END IF;/gi;
  let m;
  while ((m = re.exec(chunk)) !== null) out.push({ cond: m[1], block: m[2] });
  return out;
}

/** Columns assigned via `NEW.<col> :=` inside a chunk. */
function assignedColumns(chunk) {
  return (chunk.match(/NEW\.(\w+)\s*:=/g) || []).map((s) => s.match(/NEW\.(\w+)/)[1]);
}

/** True when `cond` tests `col` for NULL - the guard shape that was wrong. */
function guardsOnNull(cond, col) {
  return new RegExp(`NEW\\.${col}\\s+IS\\s+NULL`, 'i').test(cond)
      || new RegExp(`COALESCE\\s*\\(\\s*NEW\\.${col}\\b`, 'i').test(cond);
}

const body = functionBody(NEW_MIGRATION);
const { insert, update } = branches(body);

describe('the defect is real - the Pass 43 original guards the UPDATE path', () => {
  // Positive control baked into the suite: if this ever stops being true, the
  // premise of the fix has changed and the fix needs re-justifying.
  test('pass-43 assigns both derived columns under an IS NULL guard on themselves', () => {
    const original = functionBody(PASS43_MIGRATION);
    expect(() => branches(original)).toThrow(); // no TG_OP split at all
    // recruitment_status is excluded on purpose: it is a DEFAULT, not a
    // derivation, so guarding it on its own NULL is the right thing and is
    // kept. The two derived columns are the ones the guard broke.
    const guarded = ifBlocks(original)
      .filter(({ cond, block }) => assignedColumns(block)
        .some((col) => DERIVED.includes(col) && guardsOnNull(cond, col)))
      .map(({ block }) => assignedColumns(block).filter((c) => DERIVED.includes(c)))
      .flat();
    expect(guarded.sort()).toEqual([...DERIVED].sort());
  });
});

describe('UPDATE branch - recomputes unconditionally', () => {
  test('both derived columns are assigned on the UPDATE path', () => {
    expect(assignedColumns(update).sort()).toEqual([...DERIVED].sort());
  });

  test.each(DERIVED)('no assignment to %s is guarded on %s being NULL', (col) => {
    const offending = ifBlocks(update).filter(
      ({ cond, block }) => assignedColumns(block).includes(col) && guardsOnNull(cond, col),
    );
    expect(offending).toEqual([]);
  });

  test('the surviving guards test the SOURCE column, not the target', () => {
    // target_qualified_count derives from respondent_count; the ceiling from
    // total_price_usd. Guarding on those is input validity, and is correct.
    const conds = ifBlocks(update).map(({ cond }) => cond).join(' ');
    expect(conds).toMatch(/NEW\.respondent_count\s+IS\s+NOT\s+NULL/i);
    expect(conds).toMatch(/COALESCE\s*\(\s*NEW\.total_price_usd/i);
  });

  test('the ceiling formula is unchanged from Pass 43 (price x 0.30, 4dp)', () => {
    expect(update).toMatch(/ai_spend_ceiling_usd\s*:=\s*ROUND\(\s*NEW\.total_price_usd\s*\*\s*0\.30\s*,\s*4\s*\)/i);
  });
});

describe('INSERT branch - the original guards are preserved', () => {
  test.each(DERIVED)('%s is still only populated when it arrives NULL', (col) => {
    const guarded = ifBlocks(insert).filter(
      ({ cond, block }) => assignedColumns(block).includes(col) && guardsOnNull(cond, col),
    );
    expect(guarded.length).toBe(1);
  });
});

describe('the rest of the trigger contract is intact', () => {
  test('recruitment_status still defaults to pending on both paths', () => {
    expect(body).toMatch(/NEW\.recruitment_status\s+IS\s+NULL/i);
    expect(body).toMatch(/NEW\.recruitment_status\s*:=\s*'pending'/i);
  });

  test('it replaces the function only - the Pass 43 trigger is left alone', () => {
    const sql = fs.readFileSync(NEW_MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ensure_recruitment_columns/i);
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/DROP\s+TRIGGER/i);
  });
});
