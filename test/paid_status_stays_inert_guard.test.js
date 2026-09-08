/**
 * Standing invariant: a client-inserted status='paid' must stay INERT.
 *
 * `authenticated` still holds INSERT on every column of public.missions, and
 * the client mission-create paths write `status` directly, so a crafted insert
 * CAN land a row with status='paid' that nobody ever paid for. Today that row
 * does nothing, and it does nothing for exactly three reasons:
 *
 *   1. src/routes/missions.js treats 'paid' as terminal-or-running, so
 *      POST /generate-responses answers already_running instead of starting it.
 *   2. src/jobs/runMission.js claims the row with an UPDATE scoped to
 *      .eq('status','paid'), so a run can only be entered by a caller that
 *      already had the row (webhook / confirm), never by the row's own status
 *      attracting a worker.
 *   3. No poller SCANS for status='paid' and calls runMission. missionRecovery
 *      job1 scans 'processing', job2 scans 'pending_payment' (PI-bound), job3
 *      scans 'processing'.
 *
 * Reason 3 is a load-bearing absence, and an absence is what nobody notices
 * deleting. One new poller, admin sweeper or third money door that scans for
 * 'paid' turns a free INSERT into a free mission run. This suite is the test
 * that fails when that happens.
 *
 * These assertions read the ACTUAL source files off disk. They deliberately do
 * NOT restate the literals in this file and then check the restatement, which
 * is a test that passes forever no matter what production does.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC            = path.join(__dirname, '..', 'src');
const JOBS_DIR       = path.join(SRC, 'jobs');
const MISSIONS_ROUTE = path.join(SRC, 'routes', 'missions.js');
const RUN_MISSION    = path.join(JOBS_DIR, 'runMission.js');

// ── comment stripper ──────────────────────────────────────────────────────
// A first cut at this scan flagged a logger message and a prose comment that
// merely QUOTED `.eq('status','processing')`, so comments have to come out
// before anything is matched. Offsets are preserved (comment bytes become
// spaces) so a hit can still be reported by line number.
function stripComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line';  out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'")      state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i += 1; continue;
    }
    // inside a string / template literal — kept verbatim, escapes respected
    if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
    if ((state === 'sq'  && c === "'")
     || (state === 'dq'  && c === '"')
     || (state === 'tpl' && c === '`')) state = 'code';
    out += c; i += 1; continue;
  }
  return out;
}

/**
 * The stripper is the weakest link in this suite: if it silently mangled a
 * file (a mis-parsed string, an unbalanced state) the scan below would read
 * garbage and pass on everything. So every stripped file is re-parsed. A
 * stripper bug becomes a loud failure here instead of a quiet all-clear.
 */
function stripAndVerify(file) {
  const stripped = stripComments(fs.readFileSync(file, 'utf8'));
  expect(() => new vm.Script(`(async function(){\n${stripped}\n})`, { filename: file }))
    .not.toThrow();
  return stripped;
}

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listJsFiles(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ── supabase chain classification ─────────────────────────────────────────
// A status filter on its own says nothing; what matters is whether the chain
// it sits in is a READ (a poller looking for work) or a WRITE (runMission's
// idempotency claim). Classify by the chain segment between the nearest
// preceding `.from(` and the filter itself.
//
// Fail-closed: a segment with no write verb is treated as a read, so a poller
// written as `.from(t).eq('status','paid').select()` — filter before select —
// is still caught.
const WRITE_VERBS = ['.update(', '.upsert(', '.delete(', '.insert('];

function chainSegment(stripped, matchIndex) {
  const from = stripped.lastIndexOf('.from(', matchIndex);
  return stripped.slice(from === -1 ? 0 : from, matchIndex);
}

function isWriteChain(segment) {
  return WRITE_VERBS.some((v) => segment.includes(v));
}

/** Every place a file filters a query to status='paid', classified. */
function findPaidStatusFilters(stripped) {
  const hits = [];
  const record = (kind, index) => {
    const segment = chainSegment(stripped, index);
    hits.push({ kind, index, line: lineOf(stripped, index), segment, write: isWriteChain(segment) });
  };
  for (const m of stripped.matchAll(/\.eq\(\s*(['"])status\1\s*,\s*(['"])paid\2\s*\)/g)) {
    record('eq', m.index);
  }
  // `.in('status', [...])` including 'paid' is the same door with a wider frame.
  for (const m of stripped.matchAll(/\.in\(\s*(['"])status\1\s*,\s*(\[[^\]]*\])/g)) {
    if (/['"]paid['"]/.test(m[2])) record('in', m.index);
  }
  return hits;
}

describe('the scanner itself is looking at real files', () => {
  test('src/jobs is discovered and contains the two known job files', () => {
    const files = listJsFiles(JOBS_DIR).map((f) => path.basename(f));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual(expect.arrayContaining(['runMission.js', 'missionRecovery.js']));
  });

  test('the classifier separates a read scan from a write claim', () => {
    // Two synthetic chains, so a classifier that answered "write" (or "read")
    // for everything cannot make the real scan below pass by accident.
    const read  = `supabase.from('missions').select('id').eq('status', 'paid');`;
    const write = `supabase.from('missions').update({ status: 'processing' }).eq('id', id).eq('status', 'paid');`;
    expect(findPaidStatusFilters(read)[0].write).toBe(false);
    expect(findPaidStatusFilters(write)[0].write).toBe(true);
  });

  test('the stripper removes comments and keeps code', () => {
    const stripped = stripComments(
      `const a = 1; // .eq('status', 'paid')\n/* .eq('status','paid') */\nconst b = ".eq('status','paid')";\n`,
    );
    expect(stripped).toMatch(/const a = 1;/);
    expect(stripped).toMatch(/const b =/);
    // Two of the three occurrences were commentary; the string literal is code.
    expect(findPaidStatusFilters(stripped)).toHaveLength(1);
  });
});

describe('reason 1 — the route treats paid as terminal-or-running', () => {
  const src = fs.readFileSync(MISSIONS_ROUTE, 'utf8');

  test("TERMINAL_OR_RUNNING contains 'paid'", () => {
    const m = src.match(/const\s+TERMINAL_OR_RUNNING\s*=\s*new Set\(\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const members = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    expect(members).toContain('paid');
    // The other three are pinned too: dropping any of them reopens a
    // re-trigger door of its own.
    expect(members).toEqual(expect.arrayContaining(['processing', 'completed', 'failed']));
  });

  test('the set is actually consulted by the generate-responses guard', () => {
    // A Set nobody reads gates nothing.
    expect(stripAndVerify(MISSIONS_ROUTE)).toMatch(/TERMINAL_OR_RUNNING\.has\(/);
  });
});

describe("reason 2 — runMission's claim is scoped to status='paid'", () => {
  const hits = findPaidStatusFilters(stripAndVerify(RUN_MISSION));

  test('the claim exists and is a WRITE, not a scan', () => {
    expect(hits.filter((h) => h.write).length).toBeGreaterThan(0);
  });

  test("the claim flips the row to 'processing' only from 'paid'", () => {
    const claim = hits.find((h) => h.write);
    expect(claim.segment).toMatch(/\.update\(/);
    expect(claim.segment).toMatch(/status:\s*['"]processing['"]/);
  });
});

describe('reason 3 — no job SCANS for paid in order to trigger a run', () => {
  const jobFiles = listJsFiles(JOBS_DIR);

  test.each(jobFiles.map((f) => [path.relative(SRC, f), f]))(
    'src/%s does not read-scan missions by status=paid',
    (rel, file) => {
      const reads = findPaidStatusFilters(stripAndVerify(file)).filter((h) => !h.write);
      const detail = reads.map((h) => `  ${rel}:${h.line} (${h.kind})`).join('\n');
      expect(reads.length === 0 ? '' : `\n${detail}`).toBe('');
    },
  );

  test('the pollers that DO exist scan the statuses they are documented to scan', () => {
    // Pins the shape of the recovery sweeps, so "job2 now scans paid instead
    // of pending_payment" is a failure here and not a silent money door.
    const recovery = stripAndVerify(path.join(JOBS_DIR, 'missionRecovery.js'));
    expect(recovery).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]processing['"]\s*\)/);
    expect(recovery).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]pending_payment['"]\s*\)/);
    expect(findPaidStatusFilters(recovery)).toHaveLength(0);
  });
});
