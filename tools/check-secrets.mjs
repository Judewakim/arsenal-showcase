#!/usr/bin/env node
// Is every Amplify secret set at the path its function actually reads?
//
// ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
//
// Amplify Gen 2 does not fail a deploy when a secret is missing. `secret('X')`
// puts the literal string `<value will be resolved during runtime>` in the
// function's environment and resolves it from SSM at COLD START. If the
// parameter is not there, nothing complains: the deploy is green, the function
// boots, and the placeholder is handed to whatever third party was supposed to
// get a credential.
//
// The trap is the path. Branch secrets live at
//
//     /amplify/<app>/<branch>-branch-<hash>/<KEY>
//
// and a value typed into the obvious-looking `/amplify/<app>/<branch>/<KEY>` is
// read by nothing, forever. It has now happened three times:
//
//   2026-09-14  Stripe    — checkout sent Stripe the placeholder
//   2026-09-22  Calendly  — a user could not connect, and was logged out for it
//   2026-09-22  Google    — same, latent, found while fixing Calendly
//
// This is exactly the failure class hard rule #5 names: tsc, tests and CDK
// synth are all green while production is broken, because the fault is in the
// deployed stack and not in the source. So this check has to run against a real
// account, like check-stack-cycles.mjs, and cannot be replaced by a unit test.
//
// Related tools:
//   check-stripe-secrets.mjs      — are the Stripe VALUES the right shape?
//   fix-amplify-secret-paths.mjs  — repair: copy a secret to the right path
// This one asks only "is it set where it is read?", for every secret, and never
// writes anything.
//
// ═══ WHAT IT NEVER DOES ═══════════════════════════════════════════════════
//
// Read or print a secret value. It only ever asks SSM whether a NAME exists.
//
// ═══ USAGE ════════════════════════════════════════════════════════════════
//
//   node tools/check-secrets.mjs                 # every branch in the account
//   node tools/check-secrets.mjs --branch main   # just one
//
// Exit 0 when every declared secret resolves, 1 when any would resolve to a
// placeholder, 2 if it could not read at all — which is not a clean result and
// must not be reported as one.

import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'us-east-1';
const bIdx   = process.argv.indexOf('--branch');
const ONLY_BRANCH = bIdx > -1 ? process.argv[bIdx + 1] : null;

const ok   = (m) => console.log(`\x1b[32m  ok  \x1b[0m${m}`);
const bad  = (m) => console.log(`\x1b[31m FAIL \x1b[0m${m}`);
const warn = (m) => console.log(`\x1b[33m warn \x1b[0m${m}`);
const info = (m) => console.log(`      ${m}`);

// Git Bash rewrites a leading "/" argument into a Windows path before the CLI
// sees it, so "/amplify/…" becomes "C:/Program Files/Git/amplify/…" and SSM
// answers ParameterNotFound for a name that exists — a false FAIL that has
// already been read as a real finding once (hard rule #11).
function aws(args) {
  try {
    const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1', AWS_PAGER: '' },
    });
    return out.trim() ? JSON.parse(out) : {};
  } catch (err) {
    return { __error: String(err.stderr || err.message || err).trim().split('\n')[0] };
  }
}

console.log('\n\x1b[1mAmplify secrets — set where they are read?\x1b[0m\n');

const who = aws(['sts', 'get-caller-identity']);
if (who.__error) { bad('no AWS credentials in this shell'); info(who.__error); process.exit(2); }
info(`account   ${who.Account}   region ${REGION}`);

// No --max-results: passing it turns OFF the CLI's automatic pagination, and a
// truncated listing would report every unlisted secret as missing.
const listed = aws(['ssm', 'describe-parameters']);
if (listed.__error) { bad('could not list SSM parameters'); info(listed.__error); process.exit(2); }
const existing = new Set((listed.Parameters || []).map((p) => p.Name));

const fns = aws(['lambda', 'list-functions', '--query', 'Functions[].FunctionName']);
if (!Array.isArray(fns)) { bad('could not list Lambda functions'); info(fns?.__error); process.exit(2); }

// branch::KEY → { key, branch, readPaths, functions }
const declared = new Map();

for (const fn of fns) {
  const cfg = aws(['lambda', 'get-function-configuration', '--function-name', fn,
    '--query', 'Environment.Variables']);
  const raw = cfg?.AMPLIFY_SSM_ENV_CONFIG;
  if (cfg?.__error || typeof raw !== 'string') continue;
  let map; try { map = JSON.parse(raw); } catch { continue; }

  for (const [key, where] of Object.entries(map)) {
    const candidates = [where.path, where.sharedPath].filter(Boolean);
    if (!candidates.length) continue;
    const m = /\/amplify\/[^/]+\/([^/]+?)-branch-[0-9a-f]+\//.exec(where.path || '');
    const branch = m ? m[1] : '(shared)';
    if (ONLY_BRANCH && branch !== ONLY_BRANCH) continue;

    const id = `${branch}::${key}`;
    if (!declared.has(id)) declared.set(id, { key, branch, readPaths: new Set(), functions: new Set() });
    candidates.forEach((c) => declared.get(id).readPaths.add(c));
    declared.get(id).functions.add(fn);
  }
}

if (!declared.size) {
  warn(ONLY_BRANCH
    ? `no deployed function declares a secret for branch "${ONLY_BRANCH}"`
    : 'no deployed function declares an Amplify secret in this account');
  info('If that is a surprise, this is probably the wrong account.');
  process.exit(0);
}

let failures = 0;

for (const { key, branch, readPaths, functions } of [...declared.values()].sort(
  (a, b) => a.branch.localeCompare(b.branch) || a.key.localeCompare(b.key))) {

  const label = `${branch.padEnd(8)} ${key}`;
  const live = [...readPaths].find((p) => existing.has(p));
  if (live) { ok(`${label}  ← ${live}`); continue; }

  failures++;
  bad(`${label}  — resolves to the placeholder at runtime`);
  info(`reads   ${[...readPaths].join('\n              ')}`);
  info(`used by ${[...functions].map((f) => f.slice(0, 56)).join('\n              ')}`);

  // The most useful next line: it usually DOES exist, one path over.
  const elsewhere = [...existing].filter((n) => n.endsWith(`/${key}`));
  if (elsewhere.length) {
    info(`it exists at ${elsewhere.join(', ')} — which nothing reads`);
    info('fix: node tools/fix-amplify-secret-paths.mjs --apply');
  } else {
    info('no copy exists anywhere in this account — it has never been set');
  }
  console.log('');
}

console.log('');
if (failures) {
  bad(`${failures} secret(s) will resolve to "<value will be resolved during runtime>"`);
  info('Whatever consumes them will receive that literal string as a credential.');
  process.exit(1);
}
ok(`all ${declared.size} declared secrets are set where their functions read them`);
process.exit(0);
