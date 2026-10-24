#!/usr/bin/env node
// Find circular dependencies in a synthesized backend BEFORE a deploy does —
// both BETWEEN nested stacks and WITHIN a single stack's own resources.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Amplify splits a backend into nested CloudFormation stacks — auth, data,
// function, storage, and any created with backend.createStack(). CloudFormation
// deploys them in dependency order and refuses outright if that order does not
// exist:
//
//   [CloudformationStackCircularDependencyError] The CloudFormation deployment
//   failed due to circular dependency found between nested stacks
//   [auth, ProtectionStack, data, function, VoiceStack]
//
// Nothing before the deploy sees it. `tsc` is happy, the tests are happy, and a
// CDK SYNTH IS HAPPY — every template is individually valid, and the cycle
// exists only in the references between them. The real one this repo hit was:
//
//   auth -> function -> ProtectionStack -> data -> auth
//
// created by a single line. `topic.addSubscription(new LambdaSubscription(fn))`
// builds the subscription in the TOPIC's stack and the `AWS::Lambda::Permission`
// in the FUNCTION's stack, pointing back at the topic — so a topic and its
// subscriber in different stacks is a two-way edge, and it only takes one more
// hop to close a loop. It shipped in a commit that was never deployed and
// surfaced weeks later, on somebody else's unrelated task.
//
// ─── THE SECOND FAILURE CLASS (T-293) ──────────────────────────────────────
// This tool used to check ONLY the edges between nested stacks and said so in
// this comment, and that sentence is exactly what let a DIFFERENT class of
// cycle through: a cycle between two resources INSIDE the same template. Job
// 39 failed with `CloudformationResourceCircularDependencyError` (not the
// stack-level error above) between four resources in the `data` nested
// stack — a Lambda, its own Function URL, and two invoke permissions — because
// `fn.addEnvironment('X', functionUrl.url)` put the Function URL's value into
// the Function's own environment: Function -> FunctionUrl (needs its URL) and
// FunctionUrl -> Function (needs its ARN as TargetFunctionArn) is a two-node
// cycle CloudFormation cannot order, and CDK's local synth does not reject it
// — this exact tool exited 0 on the template that job 39's deploy refused.
//
// So this tool now does TWO walks over the same synthesized templates:
//   1. Nested-stack walk (original): edges between `AWS::CloudFormation::Stack`
//      resources in the ROOT template, built from each nested stack's
//      `Parameters` (what it needs from outside) and `DependsOn`.
//   2. Intra-stack walk (new): for EVERY template — root and nested — edges
//      between that template's OWN resources, built from `Ref`, `Fn::GetAtt`
//      and `DependsOn` found anywhere in each resource's `Properties` and
//      `Metadata`. This is the honest, complete graph: a cycle in resolved
//      Ref/GetAtt/DependsOn edges is BY DEFINITION something CloudFormation
//      cannot order, not a heuristic and not narrowed to any one resource
//      shape (no Lambda/FunctionUrl allowlist — it would have caught this
//      failure with a topic/subscriber pair, a KMS key and its only user, or
//      anything else with the same two-way edge).
//
// A cycle from EITHER walk fails the check. Neither walk is a substitute for
// the other: a nested-stack cycle can exist with every individual template
// internally acyclic, and an intra-stack cycle can exist inside one perfectly
// well-ordered nested stack.
//
// ─── WHAT THIS STILL DOES NOT PROVE ────────────────────────────────────────
// A synth exiting 0 proves nothing about either class of cycle — that is the
// whole reason this tool exists instead of just running synth. But this tool
// walking both graphs and finding nothing is still a STATIC read of the same
// Ref/GetAtt/DependsOn edges CloudFormation itself uses to order resources; it
// is not a deploy. A real `cdk deploy` / Amplify pipeline run is the only
// thing that proves CloudFormation accepts the template.
//
// ─── USAGE ──────────────────────────────────────────────────────────────────
//   node tools/check-stack-cycles.mjs
//
// Synthesizes into a temp directory and walks every `*.template.json` it
// produces. Needs no AWS credentials and touches nothing. Exit 0 clean
// (both walks), 1 on a cycle (either walk), 2 if it could not synthesize or
// found nothing to examine (which is a different problem and must not read
// as "no cycles" — see CLAUDE.md, "Checks that cannot fail"). Every run
// prints how many templates and how many resources it examined, for both
// walks, regardless of outcome.
//
// ─── HOW TO FIX ONE ─────────────────────────────────────────────────────────
// Nested-stack cycle: find the edge that should not exist and move ONE
// resource. Usually a resource pair that belongs together has been split
// across stacks: a topic and its subscriber, a function and the thing it is
// triggered by, a key and its only user. `Stack.of(x)` puts a construct in
// the same stack as `x`, and `resourceGroupName` on defineFunction picks a
// function's stack.
//
// Intra-stack cycle: find the property that reads a value FROM a resource
// that itself needs something FROM the resource being defined. The fix is
// usually to break the feedback loop entirely rather than reorder it — e.g.
// resolve the value at RUNTIME (an SDK call in the handler) instead of at
// synth time, so nothing in the CDK graph points back at itself. See
// `amplify/backend.ts`'s `SmsInboundSelfLookupPolicy` comment (T-221/T-293)
// for a worked example, including why the "obvious" alternative
// (`fn.addToRolePolicy` naming the function's own ARN) silently recreates the
// same cycle one hop later through the function's own default policy.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

const ok   = (m) => console.log(`\x1b[32m  ok  \x1b[0m${m}`);
const bad  = (m) => console.log(`\x1b[31m FAIL \x1b[0m${m}`);
const info = (m) => console.log(`      ${m}`);

// ── synth ───────────────────────────────────────────────────────────────────

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-cycles-'));

console.log('\n\x1b[1mStack cycle check — nested-stack AND intra-stack\x1b[0m\n');
info('synthesizing (about 30 seconds, no AWS calls)...');

try {
  execFileSync('npx', ['tsx', 'amplify/backend.ts'], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CDK_OUTDIR: outdir,
      // Without this, defineBackend throws "No context value present for
      // amplify-backend-namespace key", which looks like a broken command
      // rather than a missing argument.
      CDK_CONTEXT_JSON: JSON.stringify({
        'amplify-backend-namespace': 'cyclecheck',
        'amplify-backend-name': 'cyclecheck',
        'amplify-backend-type': 'sandbox',
      }),
    },
    shell: process.platform === 'win32',
  });
} catch (err) {
  bad('could not synthesize — this is not a clean result, it is no result');
  const stderr = String(err.stderr ?? '');
  // Amplify base64-encodes the real cause; the readable message is often just
  // "Failed to instantiate data construct".
  const encoded = stderr.match(/serializedError: '([A-Za-z0-9+/=]+)'/);
  if (encoded) {
    try {
      info(JSON.parse(Buffer.from(encoded[1], 'base64').toString()).cause?.message ?? '');
    } catch { /* fall through to the raw tail */ }
  }
  info(stderr.split('\n').filter((l) => /Error|error:/.test(l)).slice(0, 4).join('\n      '));
  process.exit(2);
}

// ── discover templates ──────────────────────────────────────────────────────

const files = fs.readdirSync(outdir).filter((f) => f.endsWith('.template.json'));
const rootFile = files.find((f) => !f.includes('.nested.'));
if (!rootFile) {
  bad('no root template in the assembly — the synth produced something unexpected');
  process.exit(2);
}
if (!files.length) {
  bad('found no templates at all — the walk is broken, not the backend');
  process.exit(2);
}

let anyCycle = false;

// ── walk 1: nested-stack edges (root template only) ─────────────────────────

const root = JSON.parse(fs.readFileSync(path.join(outdir, rootFile), 'utf8'));
const nested = Object.entries(root.Resources)
  .filter(([, v]) => v.Type === 'AWS::CloudFormation::Stack')
  .map(([k]) => k);

if (!nested.length) {
  bad('found no nested stacks — the walk is broken, not the backend');
  process.exit(2);
}

/** Every logical id referenced anywhere inside a value. */
function refsIn(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) refsIn(n, out); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'Fn::GetAtt' && Array.isArray(v)) out.add(v[0]);
    else if (k === 'Ref' && typeof v === 'string') out.add(v);
    else refsIn(v, out);
  }
  return out;
}

// A nested stack's parameters are exactly the values it needs from elsewhere,
// so they are the dependency edges.
const stackEdges = new Map();
for (const id of nested) {
  const res = root.Resources[id];
  const deps = new Set();
  for (const t of refsIn(res.Properties?.Parameters ?? {})) {
    if (nested.includes(t) && t !== id) deps.add(t);
  }
  for (const d of res.DependsOn ?? []) {
    if (nested.includes(d) && d !== id) deps.add(d);
  }
  stackEdges.set(id, deps);
}

const short = (s) => s.replace(/[0-9A-F]{8}$/, '');

console.log('\n\x1b[1m1. Nested-stack edges\x1b[0m\n');
for (const [k, v] of stackEdges) {
  info(`${short(k).padEnd(22)} -> ${[...v].map(short).join(', ') || '(nothing)'}`);
}

const stackCycles = [];
{
  const done = new Set();
  const walk = (node, stack) => {
    const at = stack.indexOf(node);
    if (at !== -1) { stackCycles.push([...stack.slice(at), node]); return; }
    if (done.has(node)) return;
    stack.push(node);
    for (const n of stackEdges.get(node) ?? []) walk(n, stack);
    stack.pop();
    done.add(node);
  };
  for (const n of stackEdges.keys()) walk(n, []);
}

console.log('');
if (!stackCycles.length) {
  ok(`${nested.length} nested stacks, no circular dependencies`);
} else {
  anyCycle = true;
  bad(`${stackCycles.length} nested-stack circular ${stackCycles.length === 1 ? 'dependency' : 'dependencies'} — `
    + 'CloudFormation will refuse this deployment');
  for (const c of stackCycles) info(c.map(short).join(' -> '));
  console.log('');
  info('Move ONE resource to break the loop. The usual cause is a pair that');
  info('belongs together being split across stacks — a topic and its subscriber,');
  info('a key and its only user. Stack.of(x) co-locates a construct with x;');
  info('resourceGroupName on defineFunction picks a function\'s stack.');
}

// ── walk 2: intra-stack resource edges (every template) ─────────────────────
//
// For each template independently: every resource's own Ref/Fn::GetAtt/
// DependsOn edges to OTHER resources in that same template. A cycle here is
// exactly the class CloudFormation rejects with
// CloudformationResourceCircularDependencyError — it has nothing to do with
// nested-stack boundaries and walk 1 above cannot see it (job 39's cycle was
// a Lambda and its own Function URL, both inside the `data` nested stack).

console.log('\n\x1b[1m2. Intra-stack resource edges (every template)\x1b[0m\n');

let totalResources = 0;
const intraCycles = []; // { file, chain }

function collectRefs(node, ids, out) {
  if (Array.isArray(node)) { for (const n of node) collectRefs(n, ids, out); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'Ref' && typeof v === 'string') {
      if (ids.has(v)) out.add(v);
    } else if (k === 'Fn::GetAtt') {
      const target = Array.isArray(v) ? v[0] : String(v).split('.')[0];
      if (ids.has(target)) out.add(target);
    } else {
      collectRefs(v, ids, out);
    }
  }
}

for (const file of files) {
  const tpl = JSON.parse(fs.readFileSync(path.join(outdir, file), 'utf8'));
  const resources = tpl.Resources || {};
  const ids = new Set(Object.keys(resources));
  totalResources += ids.size;
  if (!ids.size) continue;

  const edges = new Map();
  for (const [id, body] of Object.entries(resources)) {
    const out = new Set();
    collectRefs(body.Properties, ids, out);
    collectRefs(body.Metadata, ids, out);
    for (const d of [].concat(body.DependsOn || [])) if (ids.has(d)) out.add(d);
    out.delete(id); // a resource "depending on itself" in raw JSON isn't a graph cycle
    edges.set(id, out);
  }

  // DFS with an explicit stack (recursion could blow up on ~2000+ resources).
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...ids].map((i) => [i, WHITE]));
  const callStack = [];

  const dfs = (start) => {
    const frames = [[start, [...(edges.get(start) || [])]]];
    color.set(start, GREY);
    callStack.push(start);
    while (frames.length) {
      const top = frames[frames.length - 1];
      if (!top[1].length) {
        color.set(top[0], BLACK);
        callStack.pop();
        frames.pop();
        continue;
      }
      const n = top[1].pop();
      if (color.get(n) === GREY) {
        const i = callStack.indexOf(n);
        intraCycles.push({ file, chain: [...callStack.slice(i), n] });
        return true;
      }
      if (color.get(n) === WHITE) {
        color.set(n, GREY);
        callStack.push(n);
        frames.push([n, [...(edges.get(n) || [])]]);
      }
    }
    return false;
  };

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      if (dfs(id)) break; // one cycle per file is enough to name and fail on
    }
  }
}

if (!intraCycles.length) {
  ok(`${files.length} template(s), ${totalResources} resources, no intra-stack circular dependencies`);
} else {
  anyCycle = true;
  bad(`${intraCycles.length} intra-stack circular ${intraCycles.length === 1 ? 'dependency' : 'dependencies'} — `
    + 'CloudFormation will refuse this deployment');
  for (const { file, chain } of intraCycles) {
    info(`in ${file}:`);
    info(`  ${chain.map(short).join(' -> ')}`);
  }
  console.log('');
  info('A resource pair each needing something FROM the other (e.g. a Lambda\'s');
  info('environment reading its own Function URL, whose TargetFunctionArn reads');
  info('the Lambda) cannot be reordered — resolve one side at RUNTIME instead of');
  info('in the CDK graph. See amplify/backend.ts SmsInboundSelfLookupPolicy for');
  info('a worked example, including the "obvious" fix that silently re-cycles.');
}

// ── verdict ──────────────────────────────────────────────────────────────────

console.log(`\nexamined ${files.length} template(s) (1 root, ${files.length - 1} nested), `
  + `${totalResources} resources total, ${nested.length} nested stacks, `
  + `${stackCycles.length + intraCycles.length} cycle(s) found\n`);

process.exit(anyCycle ? 1 : 0);
