/**
 * generate-pricing-targeting-golden - snapshot what every mission type is
 * charged, and how targeting is read, so a later change cannot move either
 * without a test going red.
 *
 * WHY
 * ---
 * Creative Attention gained its own targeting fields (placement, market). The
 * owner's rule was that this must not move a Creative Attention price off its
 * flat $19 / $49, and must not change any other type's price or targeting
 * behaviour. "We didn't touch pricing" is a claim; a snapshot is a check.
 *
 * The snapshot was generated from main at 2968bd2, BEFORE the placement and
 * market work, so it records the behaviour customers were already getting.
 * Regenerate it only when a price change is intended and approved:
 *
 *   node scripts/generate-pricing-targeting-golden.js
 *
 * and read the diff of test/fixtures/pricing_targeting_golden.json before
 * committing - every changed line is a customer-visible price or targeting
 * change.
 */
const fs = require('fs');
const path = require('path');
const { buildGolden } = require('../test/helpers/pricingTargetingGolden');

const out = path.join(__dirname, '..', 'test', 'fixtures', 'pricing_targeting_golden.json');
const golden = buildGolden();
// One case per line, so a price change shows up in a diff as exactly the
// lines that moved, without a 4 MB pretty-printed file.
const lines = (obj) => Object.keys(obj).sort().map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(',\n');
const body = [
  '{',
  `  "generated_from": ${JSON.stringify(golden.generated_from)},`,
  '  "cases": {', lines(golden.cases), '  },',
  '  "countries": {', lines(golden.countries), '  },',
  '  "schema": {', lines(golden.schema), '  }',
  '}',
].join('\n');
fs.writeFileSync(out, body + '\n');
console.log(`wrote ${Object.keys(golden.cases).length} priced cases, ` +
  `${Object.keys(golden.countries).length} country extractions, ` +
  `${Object.keys(golden.schema).length} schema lists to ${path.relative(process.cwd(), out)}`);
