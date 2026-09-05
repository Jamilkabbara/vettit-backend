#!/usr/bin/env node
/**
 * VETT — regenerate src/db/missionsColumns.json from the LIVE schema.
 *
 * This is the generation mechanism behind src/db/missionSchema.js. The
 * hand-maintained ALLOWED_COLUMNS list drifted 18 columns behind
 * public.missions before this existed; the fix is to stop maintaining it
 * by hand and regenerate it from information_schema instead.
 *
 * Usage:
 *   node scripts/dump-missions-schema.js            # rewrite the snapshot
 *   node scripts/dump-missions-schema.js --check    # exit 1 if it drifted
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY. READ-ONLY: it issues a
 * single SELECT against information_schema.columns and never writes to
 * the database.
 *
 * CI does NOT run this (no DB credentials in CI). CI instead asserts that
 * every column in the committed snapshot is classified — see
 * test/mission_schema_snapshot.test.js. Run this by hand after applying a
 * migration that adds or drops a missions column, then commit the result.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'src', 'db', 'missionsColumns.json');

// information_schema is not exposed through PostgREST, so the read goes
// through an RPC that the service role can execute. Falls back to probing a
// row's shape when the RPC is absent (PostgREST returns every column of a
// selected row as a key, including NULL ones).
async function fetchColumns(supabase) {
  const { data, error } = await supabase.rpc('exec_sql', {
    query: `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='missions'
            ORDER BY ordinal_position`,
  });
  if (!error && Array.isArray(data)) return data.map((r) => r.column_name);

  const probe = await supabase.from('missions').select('*').limit(1);
  if (probe.error) throw probe.error;
  if (!probe.data || probe.data.length === 0) {
    throw new Error('missions table is empty — cannot probe column shape; expose an exec_sql RPC instead');
  }
  return Object.keys(probe.data[0]);
}

async function main() {
  const check = process.argv.includes('--check');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const columns = await fetchColumns(supabase);
  columns.sort();

  const existing = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    : null;

  if (check) {
    const before = existing ? [...existing.columns].sort() : [];
    const added = columns.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !columns.includes(c));
    if (added.length === 0 && removed.length === 0) {
      console.log(`OK — snapshot matches live schema (${columns.length} columns)`);
      process.exit(0);
    }
    console.error('DRIFT between committed snapshot and live schema:');
    if (added.length) console.error('  added in DB, missing from snapshot:', added.join(', '));
    if (removed.length) console.error('  in snapshot, dropped from DB:', removed.join(', '));
    console.error('\nRun `node scripts/dump-missions-schema.js`, then classify the new');
    console.error('columns in src/db/missionSchema.js (CLIENT_PATCHABLE or SERVER_OWNED).');
    process.exit(1);
  }

  const snapshot = {
    _comment: 'GENERATED FILE — do not hand-edit. Regenerate with `node scripts/dump-missions-schema.js`.',
    table: 'public.missions',
    generated_at: new Date().toISOString(),
    column_count: columns.length,
    columns,
  };
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${columns.length} columns to ${SNAPSHOT_PATH}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
