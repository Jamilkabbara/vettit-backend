/**
 * A study produced before the quality fixes of 20 September says so, and stays
 * out of anything public.
 *
 * 29 of the 40 delivered studies carry at least one defect: respondents outside
 * the targeted markets (9), a panel repeating the same people (15), a
 * multi-select nobody could decline (20), answers filed under the wrong
 * question (11). Each flag was decided from that study's own stored data, not
 * from its date.
 *
 * None of them is deleted or rewritten. The customer paid for them and they
 * are the record of what was delivered. What changes is that they say what is
 * wrong, and that they are kept out of public surfaces, case studies and
 * benchmarks.
 */

const fs = require('fs');
const path = require('path');
const {
  QUALITY_NOTICE, qualityNotice, isFlagged, flagsOf, FLAG_REASONS,
} = require('../src/services/report/qualityNotice');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the notice', () => {
  test('is the exact wording, everywhere', () => {
    expect(QUALITY_NOTICE).toBe('Produced before quality fixes of 20 September; figures not reliable.');
  });

  test('a flagged study carries the notice and says what is wrong in plain words', () => {
    const q = qualityNotice({ quality_flags: ['duplicate_people', 'wrong_country'], quality_flagged_at: '2026-09-21T00:00:00Z' });
    expect(q.notice).toBe(QUALITY_NOTICE);
    expect(q.flags).toEqual(['duplicate_people', 'wrong_country']);
    expect(q.reasons).toEqual([
      'the panel repeated the same respondents',
      'some respondents were outside the markets this study targeted',
    ]);
    expect(q.excluded_from_public).toBe(true);
  });

  test('every flag the database allows has wording; no flag is left unexplained', () => {
    const migration = read('migrations/pass-62/01_quality_flags.sql');
    const allowed = [...migration.matchAll(/'(wrong_country|duplicate_people|undeclinable_q|misfiled_answers)'/g)]
      .map((m) => m[1]);
    expect(new Set(allowed).size).toBe(4);
    for (const flag of new Set(allowed)) expect(FLAG_REASONS[flag]).toBeTruthy();
  });

  test('a clean study carries nothing at all', () => {
    expect(qualityNotice({ quality_flags: null })).toBeNull();
    expect(qualityNotice({ quality_flags: [] })).toBeNull();
    expect(isFlagged({ quality_flags: [] })).toBe(false);
    expect(flagsOf({})).toEqual([]);
  });
});

describe('where it has to appear', () => {
  test('the report header carries it, so the person reading the figures sees it', () => {
    const src = read('src/services/report/buildReport.js');
    expect(src).toMatch(/quality: qualityNotice\(mission\)/);
    // Inside header, not bolted on somewhere below the fold.
    const headerAt = src.indexOf('header: {');
    const qualityAt = src.indexOf('quality: qualityNotice(mission)');
    expect(qualityAt).toBeGreaterThan(headerAt);
    expect(qualityAt - headerAt).toBeLessThan(600);
  });

  test('admin can see which studies are flagged', () => {
    expect(read('src/routes/admin.js')).toMatch(/quality_flags, quality_flagged_at/);
  });
});

describe('where it must never appear', () => {
  test('the public ticker excludes flagged studies', () => {
    const src = read('src/routes/missions.js');
    const start = src.indexOf("router.get('/recent-vetted'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('router.', start + 10));
    expect(block).toMatch(/\.is\('quality_flags', null\)/);
  });

  test('the landing page cites no flagged study', () => {
    // The landing quotes exactly one study by mission id, in landingStudy.ts
    // on the website. Here we pin the backend half: the id it cites must not
    // be one the flagging script would flag. The website's own check
    // (verify-landing-study) pins the rest.
    const script = read('scripts/flag-pre-fix-studies.js');
    expect(script).toMatch(/selectFlagged/);
    expect(script).toMatch(/quality_flags/);
  });
});

describe('nothing is destroyed', () => {
  test('the flagging script writes only the flag', () => {
    const src = read('scripts/flag-pre-fix-studies.js');
    expect(src).toMatch(/update\(\{ quality_flags: f\.flags, quality_flagged_at/);
    // No deletes, and no writes to any other table.
    expect(src).not.toMatch(/\.delete\(\)/);
    expect(src).not.toMatch(/from\('mission_responses'\)[\s\S]{0,120}\.(update|delete|insert|upsert)\(/);
  });

  test('it is a dry run unless told otherwise', () => {
    const src = read('scripts/flag-pre-fix-studies.js');
    expect(src).toMatch(/const DO_RUN = process\.argv\.includes\('--run'\)/);
    expect(src).toMatch(/DRY RUN\. Nothing was changed/);
  });
});
