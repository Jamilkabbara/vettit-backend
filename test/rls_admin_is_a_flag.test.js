/**
 * Admin access is a property of the account, not a string in a policy.
 *
 * missions_select granted read to a hardcoded email, 'kabbarajamil@gmail.com'.
 * That trusts an email claim in the token rather than an account property, and
 * it hands everything to whoever holds that address if it is ever changed or
 * re-registered. Every other admin check on this project uses is_admin_user(),
 * which reads profiles.is_admin.
 *
 * This pins the migration, so the literal cannot come back in a later one.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

function everyMigrationFile() {
  const out = [];
  for (const pass of fs.readdirSync(MIGRATIONS)) {
    const dir = path.join(MIGRATIONS, pass);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.sql')) out.push({ file: `${pass}/${f}`, sql: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  return out;
}

test('the current missions_select policy checks the admin flag, not an email', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, 'pass-63', '01_missions_select_uses_admin_flag.sql'), 'utf8');
  expect(sql).toMatch(/CREATE POLICY missions_select/);
  expect(sql).toMatch(/is_admin_user\(\(SELECT auth\.uid\(\)\)\)/);
});

test('no migration grants access to an email address literal', () => {
  const offenders = [];
  for (const { file, sql } of everyMigrationFile()) {
    // Strip comments: the pass-63 note quotes the old literal to explain it.
    const code = sql.replace(/--.*$/gm, '');
    for (const m of code.matchAll(/'[^']*@[^']*\.[a-z]{2,}'/gi)) {
      if (/CREATE POLICY|USING|WITH CHECK/i.test(code.slice(Math.max(0, m.index - 400), m.index))) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
