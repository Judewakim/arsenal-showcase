#!/usr/bin/env node
/**
 * board-sweep.mjs — find tickets that have stopped moving, and say why.
 *
 *   node tools/board-sweep.mjs          human-readable
 *   node tools/board-sweep.mjs --json   for the dashboard
 *
 * ── It proposes. It never closes. ───────────────────────────────────────────
 *
 * Only the tester closes a ticket, and that rule is load-bearing: a sweep that
 * could close things would eventually close the wrong thing at 3am with nobody
 * watching. So this writes nothing, touches no ticket and asks no agent to.
 * It produces a list for a person, which is the whole job.
 *
 * ── Why it reads git rather than the board's own fields ─────────────────────
 *
 * The obvious sweep looks for tickets sitting at a status too long. It cannot
 * be written, because a ticket carries no timestamp and no record of who picked
 * it up — status is self-reported and frequently not reported at all (the board
 * once showed 0 in-progress while seven branches held uncommitted work).
 *
 * So staleness is derived from things that cannot be forgotten into being
 * wrong: whether the ticket's branch exists, whether anyone has a worktree on
 * it, whether that tree holds changes, and whether the work already reached
 * staging. Git cannot lie about those; a status field can, and does.
 *
 * The categories, in the order they are worth a human's attention:
 *
 *   IN STAGING, NOT CLOSED  a commit carrying this ticket's id is already in
 *                         staging and the ticket still says tester-review.
 *                         This is the exact state that let twelve tickets pile
 *                         up on 2026-09-23.
 *   READY TO CLEAN        shipped: live in production, worktree still there.
 *                         The ONE late category an agent may clear itself.
 *   WAITING ON YOU        human-review or staging. The human's own queue, made
 *                         visible. Listed and never chased: no agent may move
 *                         one, and dispatching a tester at a human-review
 *                         re-verifies work a tester already passed.
 *   RETIRED STATUS        still says `review`, which was split on 2026-09-24.
 *                         A session that missed the cutover wrote it, and the
 *                         two halves it could mean need different people.
 *   NOTHING COMMITTED     the branch holds no commit carrying this ticket's id
 *                         and nothing is ahead of staging. An empty branch is
 *                         trivially an ancestor of staging, so the ancestry
 *                         test used to call this SHIPPED — no work at all
 *                         reading as the best possible outcome.
 *   NO DRIVER             at tester-review or in-progress, but no worktree
 *                         exists for its branch. Nobody is holding it. An agent
 *                         that died mid-run leaves precisely this trace — which
 *                         happened, so it is not hypothetical.
 *   NOTHING IN FLIGHT     in-progress, worktree exists, and it is clean. Either
 *                         nothing has started or it finished without being
 *                         marked.
 *   NEEDS A PERSON        blocked. Listed, never chased: no agent can clear it.
 *   CLOSED, NOT SHIPPED   a closed ticket whose branch never reached
 *                         origin/main. Closed under the pre-2026-09-24
 *                         definition of done; really human-review.
 *   UNCOMMITTED           a closed ticket whose worktree still holds changes.
 *                         Done and unbacked are different things.
 */
import { readTickets, ticketIdsIn } from './board.mjs';
import { parseTicket, classifyMine } from './board-queue.mjs';
import { featureOf, groupByFeature, reachesQueue } from './board-features.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');

function git(args, cwd) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// ── Parse ───────────────────────────────────────────────────────────────────
//
// Read through board.mjs rather than opening the board directly. When the board
// became one file per ticket, this tool and the dashboard both broke, because
// each had its own copy of "where the board is and how to parse it" and neither
// was updated with the storage. One reader, one place to fix.
const { tickets: rawTickets } = readTickets();

// Parsing lives in board-queue.mjs (T-232) so this sweep and board.mjs's
// `mine` command read the same fields out of the same ticket text.
const tickets = rawTickets.map(parseTicket);

// A branch field is prose as often as it is a ref: "staging (committed 7ba3f47,
// not pushed)", "fix/x (merged, branch deleted)", "(design only — no code)".
// Take the first token and only believe it if git does.
function branchOf(t) {
  const first = (t.branch || '').trim().split(/[\s,(]/)[0];
  if (!first || first.startsWith('(')) return '';
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${first}`]) ? first : '';
}

const worktrees = new Map();
for (const block of git(['worktree', 'list', '--porcelain']).split('\n\n')) {
  const path = (block.match(/^worktree (.+)$/m) || [])[1];
  if (!path) continue;
  const branch = ((block.match(/^branch (.+)$/m) || [])[1] || '').replace('refs/heads/', '');
  if (branch) worktrees.set(branch, { path, dirty: git(['status', '--porcelain'], path).split('\n').filter(Boolean).length });
}

const mergedToStaging = new Set(
  git(['branch', '--merged', 'staging', '--format=%(refname:short)']).split('\n').map(s => s.trim()).filter(Boolean)
);

// A merge to main IS the production deploy, so "is it shipped" is "is it in
// main" — and specifically origin/main, because commits sitting unpushed on a
// local main have deployed nothing. Fall back to local main only when there is
// no remote to ask.
const PROD_REF = git(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main' : 'main';

// Per-branch, computed once each and only for branches that turn up. "Needs a
// commit" and "needs a merge" are different asks of the human, and a queue
// that blurs them makes the reader open the ticket to find out which.
const branchClaims = new Map();
const claimsOn = br => {
  if (!branchClaims.has(br)) branchClaims.set(br, ticketIdsIn(br));
  return branchClaims.get(br);
};

const inStaging = ticketIdsIn('staging');
const inProd = ticketIdsIn(PROD_REF);
const aheadOfStaging = br => Number(git(['rev-list', '--count', `staging..${br}`]) || 0);
const mergedToProd = new Set(
  git(['branch', '--merged', PROD_REF, '--format=%(refname:short)']).split('\n').map(s => s.trim()).filter(Boolean)
);

// ── Classify ────────────────────────────────────────────────────────────────
const findings = [];
const dirtyTrees = new Map();
const unshipped = new Map();
const add = (kind, t, why, action) => findings.push({ kind, id: t.id, title: t.title, status: t.status, branch: t.branch, why, action });

// NO FEATURE: every ticket with no `feature:` line, regardless of status.
// Independent of the per-status loop below (which `continue`s past most
// tickets) because this has to see all of them, not just the open ones —
// the whole point is a gap that closes only when something nags about it
// consistently, not just while a ticket happens to be in flight. Uses
// board-features.mjs's featureOf(), imported — this file does not re-derive
// "does this ticket have a feature" on its own; three copies of one fact is
// how this repo's tools broke before (see file banner).
for (const t of tickets) {
  if (featureOf(t)) continue;
  add('NO FEATURE', t, 'no `feature:` line', 'add one, or confirm this ticket is not part of a named feature');
}

// The human's queue -- WAITING ON YOU and NEEDS A PERSON, below -- gates
// `dev-team` tickets through board-features.mjs's `reachesQueue` (T-271
// amendment) rather than deciding locally: `dev-team` is a 35-ticket
// catch-all and must not reach this queue unless one of its tickets is
// human-review, staging, or blocked. Every other feature (and every ticket
// with no `feature:` line at all) always passes. Grouped once here so both
// call sites below share one lookup instead of re-deriving it.
const featuresBySlug = new Map(groupByFeature(tickets).map(f => [f.slug, f]));
function passesQueueGate(t) {
  const slug = featureOf(t);
  if (!slug) return true; // no feature -- this gate is dev-team-specific, not general
  const feature = featuresBySlug.get(slug);
  return !feature || reachesQueue(feature);
}

for (const t of tickets) {
  const br = branchOf(t);
  const wt = br ? worktrees.get(br) : null;

  // Closed tickets with dirty trees are collected per WORKTREE below, not per
  // ticket. The first version emitted one finding each and produced seventeen
  // lines naming five directories — the repetition buried the signal it was
  // written to raise. The unit of this problem is the tree.
  if (t.status === 'done') {
    if (wt && wt.dirty) {
      const e = dirtyTrees.get(wt.path) || { path: wt.path, branch: br, dirty: wt.dirty, ids: [] };
      e.ids.push(t.id);
      dirtyTrees.set(wt.path, e);
      continue;
    }
    // Committed, but is it in production? On 2026-09-24 `done` was redefined
    // from "a tester verified it" to "pushed to production, worktree cleaned",
    // and every ticket closed before that carries the OLD meaning. A peer
    // session caught this within an hour of the rename: 24 tickets read `done`
    // and none were shipped, so `done` had quietly come to mean two things —
    // precisely the ambiguity the rename removed from `review`, displaced one
    // column right. Grouped by branch, because one line each would bury it.
    if (br && aheadOfStaging(br) === 0 && !inStaging.has(t.id) && !inProd.has(t.id)) {
      add('NOTHING COMMITTED', t, `closed, but no commit anywhere carries ${t.id}`,
        'a CLOSED ticket with nothing committed is the worst case here — verify it '
        + 'before trusting the close, and do not read this as shipped');
      continue;
    }
    if (br && br !== PROD_REF && !mergedToProd.has(br)) {
      const e = unshipped.get(br) || { branch: br, ids: [] };
      e.ids.push(t.id);
      unshipped.set(br, e);
    }
    continue;
  }

  if (t.status === 'blocked') {
    if (!passesQueueGate(t)) continue;
    // Wording owned by board-queue.mjs (T-232) — board.mjs's `mine` reads
    // the identical sentence, so the two can never say different things.
    const found = classifyMine(t, { claimsOn });
    add(found.kind, t, found.why, found.action);
    continue;
  }

  // The one late status an agent can clear on its own: the work is live and
  // what is left is housekeeping. It still refuses to touch a dirty tree —
  // "merged" and "nothing of value in that directory" are different claims.
  if (t.status === 'shipped') {
    add('READY TO CLEAN', t,
      wt ? `live in production; worktree ${wt.path} still exists`
         : 'live in production; worktree already gone',
      wt && wt.dirty
        ? `STOP — ${wt.dirty} uncommitted file(s) in that tree. Find out what they are before removing it`
        : wt ? `node tools/worktree.mjs done ${br}, then set done`
             : 'nothing left to clean — set done');
    continue;
  }

  if (t.status === 'human-review' || t.status === 'staging') {
    if (!passesQueueGate(t)) continue;
    // Same shared classifier as above — see board-queue.mjs.
    const found = classifyMine(t, { claimsOn });
    add(found.kind, t, found.why, found.action);
    continue;
  }

  // The rename's own failure mode. Do not try to infer which half it meant:
  // one waits on a tester and the other waits on the human, and guessing wrong
  // either re-verifies finished work or parks live work on someone who is not
  // expecting it.
  if (t.status === 'review') {
    add('RETIRED STATUS', t, 'status `review` was split on 2026-09-24',
      'read the ticket and set tester-review or human-review — do not guess');
    continue;
  }

  if (t.status !== 'tester-review' && t.status !== 'in-progress') continue;

  if (inStaging.has(t.id)) {
    add('IN STAGING, NOT CLOSED', t, `a commit for ${t.id} is already in staging`,
      'dispatch a tester — the work shipped and the ticket never closed');
    continue;
  }

  // Nothing ahead of staging and no commit carrying this id: the branch was
  // created and nothing came of it. Worth its own category rather than being
  // folded into NO DRIVER, because "someone wandered off" and "an agent ran and
  // produced nothing" need different responses — and the second is the one that
  // used to render as a clean bill of health.
  if (br && aheadOfStaging(br) === 0 && !inProd.has(t.id)) {
    add('NOTHING COMMITTED', t, `branch ${br} holds no commit for ${t.id}`,
      wt && wt.dirty
        ? `work is uncommitted in ${wt.path} — may still be in flight, check before re-dispatching`
        : 'nothing was produced. An agent that died mid-run leaves exactly this trace');
    continue;
  }
  if (br && !wt) {
    add('NO DRIVER', t, `branch ${br} exists but no worktree holds it`,
      'nobody is working on this — re-dispatch, or close it');
    continue;
  }
  if (!br && t.status === 'in-progress') {
    add('NO DRIVER', t, 'in-progress with no resolvable branch',
      'find out who owns it, or reset it to todo');
    continue;
  }
  if (t.status === 'in-progress' && wt && wt.dirty === 0) {
    add('NOTHING IN FLIGHT', t, `worktree ${wt.path} is clean`,
      'either it never started or it finished without being marked');
  }
}

// One finding per unshipped branch. The wording matters: these tickets were
// closed correctly under the definition in force at the time, and were
// reclassified by a definition CHANGE, not by anyone falling behind. A queue
// that appears fully formed overnight reads as neglect unless it says why it
// appeared, and that misreading costs real engagement with real work.
for (const e of unshipped.values()) {
  findings.push({
    kind: 'CLOSED, NOT SHIPPED',
    id: e.branch,
    title: `${e.ids.length} ticket${e.ids.length === 1 ? '' : 's'}: ${e.ids.join(', ')}`,
    status: 'done',
    branch: e.branch,
    why: `committed on ${e.branch}, which is not merged into ${PROD_REF}`,
    action: 'closed under the OLD definition of done (a tester passed it). Not neglected — '
      + 'redefined on 2026-09-24. Each is really human-review: verified, waiting on a merge',
  });
}

// One finding per dirty tree, naming the closed tickets that depend on it.
for (const e of dirtyTrees.values()) {
  findings.push({
    kind: 'UNCOMMITTED',
    id: e.branch || '(detached)',
    title: `${e.ids.length} closed ticket${e.ids.length === 1 ? '' : 's'}: ${e.ids.join(', ')}`,
    status: 'done',
    branch: e.branch,
    why: `${e.dirty} uncommitted file(s) in ${e.path}`,
    action: 'commit the work, or confirm it was abandoned on purpose — closed is not the same as backed up',
  });
}

const ORDER = [
  'WAITING ON YOU',          // the human's queue: nothing else moves until these do
  'UNCOMMITTED',             // work that exists in exactly one place
  'CLOSED, NOT SHIPPED',     // says done, never reached production
  'IN STAGING, NOT CLOSED',  // reached staging, ticket never closed
  'NOTHING COMMITTED',       // an agent ran and produced nothing
  'READY TO CLEAN',          // live; an agent can finish this one
  'RETIRED STATUS',          // still carrying a word the tools no longer use
  'NO DRIVER',
  'NOTHING IN FLIGHT',
  'NEEDS A PERSON',
  'NO FEATURE',              // informational; not a stall, just an unclosed gap
];
findings.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2));
  process.exit(0);
}

if (!findings.length) {
  console.log('\n  Nothing stalled. Every open ticket has a branch, a driver, or a person.\n');
  process.exit(0);
}

console.log('');
let last = '';
for (const f of findings) {
  if (f.kind !== last) { console.log(`  ── ${f.kind} ──`); last = f.kind; }
  if (f.title.length <= 62) {
    console.log(`  ${f.id}  ${f.title}`);
  } else {
    // Wrap on commas so ids stay whole; fall back to a hard cut for prose.
    const isIdList = f.title.includes(', T-');
    const parts = isIdList ? f.title.split(', ') : [f.title.slice(0, 62)];
    const pad = ' '.repeat(f.id.length + 4);
    let line = '';
    const lines = [];
    for (const p of parts) {
      if (line && (line + ', ' + p).length > 62) { lines.push(line); line = p; }
      else line = line ? line + ', ' + p : p;
    }
    if (line) lines.push(line);
    console.log(`  ${f.id}  ${lines[0]}`);
    for (const l of lines.slice(1)) console.log(`${pad}${l}`);
  }
  console.log(`         ${f.why}`);
  console.log(`         → ${f.action}`);
}
console.log(`\n  ${findings.length} finding(s). This tool proposes; it never closes a ticket.\n`);
