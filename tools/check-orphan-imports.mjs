#!/usr/bin/env node
// Does anything in the tree import something that isn't really there?
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
// With several sessions working in one tree, `git commit` sweeps up whatever is
// staged and leaves the rest. It is entirely possible — and happened on
// 2026-09-08 — for `amplify/backend.ts` to be committed while
// `amplify/functions/dial/resource.ts`, which it imports, stayed untracked.
//
// Nothing local catches that by accident: your working tree has both files, so
// `tsc` passes, `npm test` passes, and CDK synth passes. The failure appears
// only where the tree is reconstructed from git alone: CI, a fresh clone, or
// the Amplify build container. There it is not a subtle bug — the importing
// file cannot be loaded at all, so the deploy dies before it touches AWS.
//
// ─── T-182 ──────────────────────────────────────────────────────────────────
// This tool used to read file content exclusively via `git show HEAD:<file>`.
// Every feature branch in this repo works UNCOMMITTED, because agents are
// forbidden to commit before review. On such a branch, HEAD is whatever was
// last merged — not the change anyone is pointing this tool at — so the old
// default examined nothing relevant and exited 0. That 0 was cited as "green"
// on nearly every ticket closed in one run. It was not wrong; it was empty.
//
// The default is now the WORKING TREE: every tracked file as it sits on disk,
// plus every untracked file git would actually let you commit (not gitignored
// junk). Pass --committed to restore the old HEAD-only behaviour, for the one
// case it is legitimate: proving a branch that is genuinely, fully committed
// is self-consistent from git's own perspective.
//
// This script also runs a second, related check: a relative import missing
// its `.ts` extension. That import typechecks (tsc's classic resolution
// allows it) and can even run under a `tsx`-style loader, but a plain
// `node file.mjs` — which is exactly how `test/run.mjs` runs — cannot resolve
// it, so the importing file silently never executes and the suite reports
// green regardless. Same failure shape as the orphan-import bug: a check that
// cannot fail on the thing it's pointed at.
//
//   node tools/check-orphan-imports.mjs              # working tree (default, safe)
//   node tools/check-orphan-imports.mjs --committed   # HEAD only (old behaviour)
//
// Exit 0 = examined at least one file; every import resolved.
// Exit 1 = examined at least one file; something is broken. Output names it.
// Exit 2 = examined ZERO files. This is not a pass. Something upstream (a
//          bad path, an empty tree, a filter bug) means this run proved
//          nothing, and it must never be reported the same way as exit 0.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const committedMode = process.argv.includes('--committed');

// ─── Build the file list to examine ────────────────────────────────────────
let fileList;
if (committedMode) {
  fileList = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
} else {
  const tracked = git(['ls-files', '--cached']).split('\n').filter(Boolean);
  const others = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  fileList = [...new Set([...tracked, ...others])];
}

const knownSet = new Set(fileList); // for --committed resolution
const codeFiles = fileList.filter((f) => /\.(m?js|ts)$/.test(f) && (committedMode || existsSync(f)));

function readSource(file) {
  if (committedMode) {
    try { return git(['show', `HEAD:${file}`]); } catch { return null; }
  }
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function existsAsImportTarget(candidate) {
  return committedMode ? knownSet.has(candidate) : existsSync(candidate);
}

// Resolve a relative specifier against the importer's directory, the way Node
// does, including the extensionless and /index forms.
function candidates(fromFile, spec) {
  const dir = fromFile.split('/').slice(0, -1);
  const parts = [...dir, ...spec.split('/')];
  const norm = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') norm.pop();
    else norm.push(p);
  }
  const base = norm.join('/');
  return [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`];
}

function relativeSpecs(text) {
  const specs = new Set();
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"](\.[^'"]+)['"]/gm)) specs.add(m[1]);
  for (const m of text.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) specs.add(m[1]);
  return specs;
}

const orphans = [];
const missingTsExt = [];
let examined = 0;

for (const file of codeFiles) {
  const text = readSource(file);
  if (text === null) continue;
  examined++;

  // Only STATIC import/export-from specifiers. A quoted path inside a string
  // — a test asserting that some other file contains an import, for instance
  // — is not an import, and treating it as one produces false positives. That
  // exact false positive was hit and discarded on 2026-09-08.
  for (const spec of relativeSpecs(text)) {
    const cands = candidates(file, spec);
    const resolved = cands.find((c) => existsAsImportTarget(c));

    if (!resolved) {
      const onDiskOnly = !committedMode ? null : cands.find((c) => existsSync(c) && !knownSet.has(c));
      orphans.push({ file, spec, onDiskOnly });
      continue;
    }

    // Second check: an extensionless spec that only resolves via the .ts
    // candidate, imported from a plain .js/.mjs file. `node file.mjs` cannot
    // load that — no extension means no resolution — so the importer never
    // runs, silently, under exactly the harness this repo tests with.
    const hasExplicitExt = /\.(m?js|c?js|ts|tsx|json)$/.test(spec);
    if (!hasExplicitExt && /\.m?js$/.test(file)) {
      const tsCandidate = `${resolved}`.endsWith('.ts');
      if (tsCandidate) missingTsExt.push({ file, spec, resolved });
    }
  }
}

const mode = committedMode ? 'HEAD (--committed)' : 'working tree (default)';

if (examined === 0) {
  console.log(`\x1b[33m  NOTHING EXAMINED \x1b[0m mode=${mode} — 0 files matched. This is not a pass.`);
  console.log('  Either the tree is genuinely empty of .js/.ts files (very unlikely) or a');
  console.log('  path/filter here is broken. Do not report this as green.');
  process.exit(2);
}

let ok = true;

if (orphans.length) {
  ok = false;
  console.log(`\x1b[31m${orphans.length} orphaned import(s)\x1b[0m — mode=${mode}, ${examined} file(s) examined\n`);
  for (const p of orphans) {
    console.log(`  ${p.file}`);
    console.log(`      imports ${p.spec}`);
    console.log(`      -> ${p.onDiskOnly ? `UNTRACKED on disk: ${p.onDiskOnly}` : 'NOT FOUND anywhere'}\n`);
  }
  console.log('A tree built from this state cannot load these files. Commit them (or add');
  console.log('them, if untracked), or revert the code that imports them.\n');
}

if (missingTsExt.length) {
  ok = false;
  console.log(`\x1b[31m${missingTsExt.length} import(s) missing a required .ts extension\x1b[0m\n`);
  for (const p of missingTsExt) {
    console.log(`  ${p.file}`);
    console.log(`      imports ${p.spec}`);
    console.log(`      -> only resolves via ${p.resolved}; plain \`node\` cannot load this`);
    console.log(`         without the extension. Write it as '${p.spec}.ts' explicitly.\n`);
  }
  console.log('A file imported like this typechecks and may even run under a loader that');
  console.log('patches resolution, but `node test/run.mjs` cannot load it — so the test file');
  console.log('silently never executes while the suite still reports green.\n');
}

if (ok) {
  console.log(`\x1b[32m  ok  \x1b[0mevery import resolves and carries the extension it needs — mode=${mode}, ${examined} file(s) examined`);
  process.exit(0);
}

process.exit(1);
