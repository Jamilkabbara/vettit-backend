/**
 * The distinctness guards must stay WIRED IN, not merely exist.
 *
 * The behaviour tests (panel_distinctness, panel_collapse_fails_mission) prove
 * the guards work where they are called. These tests fail if a future change
 * stops calling them, or removes the panel context that makes generation
 * produce different people in the first place. Each assertion below maps to a
 * way the 2026-06-12 defect could come back:
 *
 *   - the loop asking for one persona at a time with no panel context
 *   - generation dropping the clone guard
 *   - the run delivering without measuring the panel
 *   - a caller of generatePersonas forgetting to pass the panel so far
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the recruit loop passes the panel so far and generates in batches', () => {
  const loop = read('src/services/ai/recruitLoop.js');
  expect(loop).toMatch(/priorPersonas:\s*generatedPersonas/);
  expect(loop).toMatch(/LOOP_BATCH_SIZE\s*=\s*([2-9]|\d{2,})/);      // never 1
  expect(loop).not.toMatch(/generatePersonas\(\s*mission,\s*1\s*,/); // the defect
});

test('persona generation keeps the clone guard and the panel-so-far block', () => {
  const personas = read('src/services/ai/personas.js');
  expect(personas).toMatch(/isNearDuplicate\(me,\s*p\)/);
  expect(personas).toMatch(/nameCap/);
  expect(personas).toMatch(/buildPanelSoFar\(/);
  expect(personas).toMatch(/ALREADY IN THIS PANEL/);
  expect(personas).toMatch(/Persona slots/);
});

test('every caller of generatePersonas passes the panel it already holds', () => {
  for (const rel of ['src/services/ai/recruitLoop.js', 'src/jobs/runMission.js']) {
    const src = read(rel);
    // Real call sites only: `generatePersonas(mission, ...`. Prose that
    // mentions the function by name is not a call.
    const calls = src.split('generatePersonas(').slice(1)
      .filter((tail) => /^\s*\n?\s*mission\b/.test(tail));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const window = call.slice(0, 400);
      // The legacy batch path builds the whole panel in one call and has no
      // prior panel to pass; it is the `generatePersonas(mission, targetCount)`
      // form with no options object at all.
      const isFirstBatch = /^mission,\s*targetCount\s*\)/.test(window);
      if (!isFirstBatch) expect(window).toMatch(/priorPersonas/);
    }
  }
});

test('the mission run measures the panel before it delivers', () => {
  const run = read('src/jobs/runMission.js');
  expect(run).toMatch(/measurePanel\(/);
  expect(run).toMatch(/REFUSING to deliver a collapsed panel/);
  // The gate must sit before synthesis, or a collapsed panel is paid for in
  // full before anything notices.
  expect(run.indexOf('measurePanel(')).toBeLessThan(run.indexOf('synthesizeInsights('));
});

test('the threshold stays tied to sample size, not a fixed count', () => {
  const measure = read('src/services/ai/panelDistinctness.js');
  expect(measure).toMatch(/Math\.sqrt\(n\)/);
  expect(measure).toMatch(/MAX_TOP_NAME_SHARE/);
});

test('CI runs the test suite', () => {
  const wf = read('.github/workflows/verify-deploy.yml');
  expect(wf).toMatch(/run:\s*npm test/);
});
