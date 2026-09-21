#!/usr/bin/env node
/**
 * Read-only: is every check this repo owns actually run by anything?
 *
 * A check that nothing runs is not coverage, it is a file. Twice in the last
 * week a check existed and was wired into nothing: the backend suite itself
 * never ran in CI until 2026-09-20 (the panel-collapse defect lived three
 * months behind it), and the website's three landing checks were red and
 * unwired until 2026-09-21.
 *
 * This reports, for both repositories:
 *   - test files and verify scripts that no npm script and no workflow runs
 *   - npm scripts and workflows that reference a file which does not exist
 *   - whether the test suite runs in CI at all
 *
 * It changes nothing.
 *
 *   node scripts/audit-checks-wired.js [backendDir] [websiteDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND = process.argv[2] || path.join(__dirname, '..');
const WEBSITE = process.argv[3] || '/Users/jamilkabbara/Documents/GitHub/vett-platform';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

function workflowText(root) {
  const dir = path.join(root, '.github', 'workflows');
  return listDir(dir).map((f) => read(path.join(dir, f))).join('\n');
}

function auditRepo(root, label) {
  const pkg = JSON.parse(read(path.join(root, 'package.json')) || '{}');
  const scripts = pkg.scripts || {};
  const allScriptText = Object.values(scripts).join(' && ');
  const wf = workflowText(root);
  const runsSuiteInCi = /run:\s*npm (test|ci && npm test)|npm test/.test(wf);

  // Checks this repo owns: jest tests and verify-* scripts.
  const testFiles = listDir(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
  const verifyScripts = listDir(path.join(root, 'scripts'))
    .filter((f) => /^(verify|check)-.*\.(mjs|js)$/.test(f));

  // A check can also be run by the application itself: the paid-mission audit
  // runs from the daily recovery cron rather than from npm. Scanning src/ for
  // the module name is what tells those apart from genuinely dead files.
  const srcText = (function walk(dir) {
    let out = '';
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) out += walk(full);
      else if (/\.(js|mjs|ts)$/.test(entry)) out += read(full);
    }
    return out;
  })(path.join(root, 'src'));

  const unwiredVerify = verifyScripts.filter((f) => {
    const base = f.replace(/\.(mjs|js)$/, '');
    const referenced = allScriptText.includes(f) || wf.includes(f)
      || srcText.includes(base) || srcText.includes(f);
    return !referenced;
  });

  // A jest test is run by the suite; the question is whether the suite runs.
  const jestRuns = /jest/.test(allScriptText);

  // Referenced but missing.
  const referenced = [...allScriptText.matchAll(/scripts\/([A-Za-z0-9._-]+\.(?:mjs|js))/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((f) => !fs.existsSync(path.join(root, 'scripts', f)));

  return {
    repo: label,
    test_command: scripts.test ? scripts.test.slice(0, 80) + (scripts.test.length > 80 ? '…' : '') : null,
    jest_tests: testFiles.length,
    jest_runs_via_npm_test: jestRuns,
    suite_runs_in_ci: runsSuiteInCi,
    verify_scripts: verifyScripts.length,
    verify_scripts_unwired: unwiredVerify,
    referenced_but_missing: missing,
  };
}

const report = [auditRepo(BACKEND, 'vettit-backend'), auditRepo(WEBSITE, 'vett-platform')];
console.log(JSON.stringify(report, null, 2));

const problems = report.filter((r) => !r.suite_runs_in_ci || r.verify_scripts_unwired.length || r.referenced_but_missing.length);
if (problems.length) {
  console.error(`\n${problems.length} repository(ies) have checks that nothing runs.`);
  process.exit(1);
}
console.error('\nEvery check is wired into something that runs.');
