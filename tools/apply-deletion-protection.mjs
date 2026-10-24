#!/usr/bin/env node
// Turn DynamoDB deletion protection ON for every Amplify table in the account.
//
// ─── WHY THIS IS A SCRIPT AND NOT A CDK PROPERTY ────────────────────────────
//
// It WAS a CDK property, and it deadlocked production on 2026-09-09.
//
// Amplify job 105 created six new tables with deletion protection on, then
// failed on an unrelated error. CloudFormation rolled back and tried to delete
// those six. Deletion protection blocked the delete — exactly as designed. The
// tables survived with no owning stack, and every deploy after it failed with
// `Table already exists` until someone cleared the protection by hand.
//
// A control set at CREATE time is a control the rollback of that same create
// has to fight. So it is applied AFTER a deploy succeeds instead. A table made
// by a deploy that later fails is unprotected at exactly the moment
// CloudFormation needs to remove it, and protected from the moment its deploy
// succeeded. Rollback undoes what it created, which is the point of rollback.
//
// ─── USAGE ──────────────────────────────────────────────────────────────────
//
//   node tools/apply-deletion-protection.mjs            # show what would change
//   node tools/apply-deletion-protection.mjs --apply    # make the change
//
// Run it after any deploy that added a model. `tools/verify-protections.mjs`
// fails if a table is left unprotected, so forgetting is caught rather than
// silently carried.
//
// Idempotent: a table already protected is skipped, not rewritten.
//
// ⚠️ NEVER run this against a sandbox account. A protected table refuses to
// delete, so `ampx sandbox delete` fails halfway and leaves a stack to unpick
// by hand. Sandboxes exist to be thrown away. It refuses unless the account
// matches PROD_ACCOUNT below.

import { execFileSync } from 'node:child_process';

const PROD_ACCOUNT = '111111111111';
const REGION = process.env.AWS_REGION || 'us-east-1';
const APPLY = process.argv.includes('--apply');

function aws(args) {
  try {
    const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    return out.trim() === '' ? {} : JSON.parse(out);
  } catch (err) {
    return { __error: (err.stderr || err.message || '').toString().trim().split('\n').pop() };
  }
}

const ident = aws(['sts', 'get-caller-identity']);
if (ident.__error) { console.error('Could not call AWS: ' + ident.__error); process.exit(2); }
if (ident.Account !== PROD_ACCOUNT) {
  console.error(`REFUSING: credentials are for ${ident.Account}, not production ${PROD_ACCOUNT}.`);
  console.error('Deletion protection on a sandbox breaks `ampx sandbox delete`.');
  process.exit(2);
}
console.log(`account ${ident.Account}  region ${REGION}`);
console.log(APPLY ? 'MODE: apply\n' : 'MODE: dry run — pass --apply to change anything\n');

const list = aws(['dynamodb', 'list-tables']);
if (list.__error) { console.error('list-tables failed: ' + list.__error); process.exit(2); }

let already = 0, changed = 0, failed = 0, skipped = 0;
for (const name of (list.TableNames || []).sort()) {
  const d = aws(['dynamodb', 'describe-table', '--table-name', name]);
  if (d.__error) { console.log(`  ?  ${name} — ${d.__error}`); failed++; continue; }

  const t = d.Table || {};
  if (t.TableStatus !== 'ACTIVE') { console.log(`  -  ${name} — ${t.TableStatus}, skipped`); skipped++; continue; }
  if (t.DeletionProtectionEnabled) { already++; continue; }

  if (!APPLY) { console.log(`  →  ${name} — WOULD protect`); changed++; continue; }

  const r = aws(['dynamodb', 'update-table', '--table-name', name, '--deletion-protection-enabled']);
  if (r.__error) { console.log(`  ✗  ${name} — ${r.__error}`); failed++; }
  else { console.log(`  ✓  ${name} — protected`); changed++; }
}

console.log(`\nalready protected: ${already}   ${APPLY ? 'protected now' : 'would protect'}: ${changed}`
  + `   skipped: ${skipped}   failed: ${failed}`);
if (!APPLY && changed) console.log('\nRe-run with --apply to make these changes.');
process.exit(failed ? 1 : 0);
