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

// ── lexing ────────────────────────────────────────────────────────────────
// The scan has to tell three lookalikes apart, because two of them are
// harmless and one is the bug:
//
//   .eq('status', 'paid')                     ← CODE. the thing we care about
//   // a comment describing .eq('status','paid')   ← prose
//   logger.debug("... .eq('status','paid')")  ← a message ABOUT the query
//
// A plain substring or line grep flags all three. So each file is lexed once
// into three same-length views (offsets preserved, so a hit still reports its
// real line):
//
//   codeMask       1 where a byte is code (string delimiters included),
//                  0 inside a comment or inside a string BODY
//   noComments     comments blanked, string bodies kept  — used to MATCH the
//                  filters, whose arguments are string literals
//   codeOnly       comments AND string bodies blanked    — used to CLASSIFY
//                  the surrounding chain, so a verb quoted in a message can
//                  never be mistaken for a call
// Views are built as UTF-16 code-unit arrays, not Buffers: these files are
// full of box-drawing characters and em dashes, and byte offsets would not
// line up with the string indices the regexes report.
function lex(src) {
  const mask       = new Uint8Array(src.length);
  const noComments = src.split('');
  const codeOnly   = src.split('');
  const blank = (buf, i) => { if (i < src.length && src[i] !== '\n') buf[i] = ' '; };

  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line';  continue; }
      if (c === '/' && d === '*') { state = 'block'; blank(noComments, i); blank(codeOnly, i); i += 1; continue; }
      if (c === "'" || c === '"' || c === '`') {
        mask[i] = 1;
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        i += 1; continue;
      }
      mask[i] = 1; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; mask[i] = 1; i += 1; continue; }
      blank(noComments, i); blank(codeOnly, i); i += 1; continue;
    }
    if (state === 'block') {
      blank(noComments, i); blank(codeOnly, i);
      if (c === '*' && d === '/') { blank(noComments, i + 1); blank(codeOnly, i + 1); state = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    // string / template body
    if (c === '\\') { blank(codeOnly, i); blank(codeOnly, i + 1); i += 2; continue; }
    if ((state === 'sq'  && c === "'")
     || (state === 'dq'  && c === '"')
     || (state === 'tpl' && c === '`')) { mask[i] = 1; state = 'code'; i += 1; continue; }
    blank(codeOnly, i); i += 1; continue;
  }
  return { mask, noComments: noComments.join(''), codeOnly: codeOnly.join('') };
}

/**
 * The lexer is the weakest link in this suite: if it silently desynced on a
 * file the scan would read garbage and pass on everything. So the blanked
 * views are re-parsed. A lexer bug becomes a loud failure here instead of a
 * quiet all-clear.
 */
function lexAndVerify(file) {
  const views = lex(fs.readFileSync(file, 'utf8'));
  for (const view of [views.noComments, views.codeOnly]) {
    expect(() => new vm.Script(`(async function(){\n${view}\n})`, { filename: file })).not.toThrow();
  }
  return views;
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

function chainSegment(codeOnly, matchIndex) {
  const from = codeOnly.lastIndexOf('.from(', matchIndex);
  return codeOnly.slice(from === -1 ? 0 : from, matchIndex);
}

/** Every place a file filters a query to status='paid', classified. */
function findPaidStatusFilters(views) {
  const { mask, noComments, codeOnly } = views;
  const hits = [];
  const record = (kind, index) => {
    if (!mask[index]) return; // the match starts inside a comment or a message string
    // Classify off codeOnly so a verb quoted in a log message cannot pass for
    // a call; inspect literals off noComments, where the payload survives.
    const segment = chainSegment(codeOnly, index);
    hits.push({
      kind, index, segment,
      payload: chainSegment(noComments, index),
      line:    lineOf(noComments, index),
      write:   WRITE_VERBS.some((v) => segment.includes(v)),
    });
  };
  for (const m of noComments.matchAll(/\.eq\(\s*(['"])status\1\s*,\s*(['"])paid\2\s*\)/g)) {
    record('eq', m.index);
  }
  // `.in('status', [...])` including 'paid' is the same door with a wider frame.
  for (const m of noComments.matchAll(/\.in\(\s*(['"])status\1\s*,\s*(\[[^\]]*\])/g)) {
    if (/['"]paid['"]/.test(m[2])) record('in', m.index);
  }
  return hits;
}

const scan = (source) => findPaidStatusFilters(lex(source));

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
    expect(scan(read)[0].write).toBe(false);
    expect(scan(write)[0].write).toBe(true);
  });

  test('prose and log messages that merely QUOTE the query are not flagged', () => {
    // This is the false-positive class that made a first attempt at this scan
    // useless. All four of these are noise; only the last line is a query.
    const noise = [
      `// never .eq('status', 'paid') to find work`,
      `/* .eq('status','paid') and .in('status',['paid']) */`,
      `logger.error("recovery must not .eq('status','paid')");`,
      "logger.warn(`saw .in('status', ['paid'])`);",
    ].join('\n');
    expect(scan(noise)).toHaveLength(0);
    expect(scan(`${noise}\nsupabase.from('m').select('id').eq('status', 'paid');`)).toHaveLength(1);
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
    expect(lexAndVerify(MISSIONS_ROUTE).codeOnly).toMatch(/TERMINAL_OR_RUNNING\.has\(/);
  });
});

describe("reason 2 — runMission's claim is scoped to status='paid'", () => {
  const hits = findPaidStatusFilters(lexAndVerify(RUN_MISSION));

  test('the claim exists and is a WRITE, not a scan', () => {
    expect(hits.filter((h) => h.write).length).toBeGreaterThan(0);
  });

  test("the claim flips the row to 'processing' only from 'paid'", () => {
    const claim = hits.find((h) => h.write);
    expect(claim.segment).toMatch(/\.update\(/);
    expect(claim.payload).toMatch(/status:\s*['"]processing['"]/);
  });
});

describe('reason 3 — no job SCANS for paid in order to trigger a run', () => {
  const jobFiles = listJsFiles(JOBS_DIR);

  test.each(jobFiles.map((f) => [path.relative(SRC, f), f]))(
    'src/%s does not read-scan missions by status=paid',
    (rel, file) => {
      const reads = findPaidStatusFilters(lexAndVerify(file)).filter((h) => !h.write);
      const detail = reads.map((h) => `  ${rel}:${h.line} (${h.kind})`).join('\n');
      expect(reads.length === 0 ? '' : `\n${detail}`).toBe('');
    },
  );

  test('the pollers that DO exist scan the statuses they are documented to scan', () => {
    // Pins the shape of the recovery sweeps, so "job2 now scans paid instead
    // of pending_payment" is a failure here and not a silent money door.
    const recovery = lexAndVerify(path.join(JOBS_DIR, 'missionRecovery.js'));
    expect(recovery.noComments).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]processing['"]\s*\)/);
    expect(recovery.noComments).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]pending_payment['"]\s*\)/);
    expect(findPaidStatusFilters(recovery)).toHaveLength(0);
  });
});
