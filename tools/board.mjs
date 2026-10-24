#!/usr/bin/env node
/**
 * board.mjs — one task board, shared by every worktree.
 *
 *   node tools/board.mjs tickets         print the ticket DIRECTORY
 *   node tools/board.mjs path            same — kept for callers that used it
 *   node tools/board.mjs show            print every ticket, concatenated
 *   node tools/board.mjs status          counts, warnings, the standing rule
 *   node tools/board.mjs next-id         reserve the next id by creating its file
 *   node tools/board.mjs init            create the board if it does not exist
 *   node tools/board.mjs archive T-101   move a done ticket into tasks/done/
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The board used to live at `tasks/board.md` inside the repo. Every git
 * worktree therefore carried its own copy, and two agents working in parallel
 * could not see each other's tickets. On the team's first real run the
 * orchestrator read a stale copy, reported finished work as not started, and
 * dispatched a second agent onto a ticket another agent had already completed.
 * They happened not to collide. That is luck, not a design.
 *
 * The board is not source code. It is the state of work in flight, and it is
 * shared by every session on this machine, so it lives OUTSIDE the repository
 * where no branch or checkout can fork it:
 *
 *     C:\dev\inbound-platform         ← the repo (any branch)
 *     C:\dev\inbound-platform-wt\*    ← worktrees, one per branch
 *     C:\dev\inbound-platform-board\  ← the board. one copy. this.
 *
 * ── How the path is resolved, and why not a constant ────────────────────────
 *
 * From a worktree, `git rev-parse --show-toplevel` returns the WORKTREE, which
 * is exactly the wrong answer — it is per-tree, which is the bug. So we ask for
 * `--git-common-dir`, which every worktree of a repo shares: it points at the
 * one real `.git`. Its parent is the main checkout no matter which tree you
 * stand in, so all trees resolve to the same board without hardcoding a Windows
 * path that a Linux box could never honour.
 *
 * `ARSENAL_BOARD` overrides it with a full path to the file, for a host that
 * lays things out differently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// board-queue.mjs never imports this file (see its header for why), so this
// import cannot cycle even though board-sweep.mjs — which DOES import this
// file — also imports board-queue.mjs. T-232.
import { buildMineQueue, formatAge, parseTicket } from './board-queue.mjs';
import { featureOf, groupByFeature, reachesQueue, statusLineForSubset, nextActionForSubset } from './board-features.mjs';

// Git, quietly: a missing ref is an empty answer, not a crash. Callers ask
// about refs that may not exist yet (no remote, a fresh clone).
export function gitOut(args, cwd) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Which ticket ids ONE commit message CLAIMS. Exactly two places count:
//
//   1. the subject line, per the one-ticket-one-commit convention; and
//   2. a "Tickets T-1, T-2 and T-3." paragraph, which is how the multi-ticket
//      commits on this repo declare their scope, and which may wrap over
//      several lines.
//
// Reading the subject alone missed every multi-ticket commit here — four of
// them carry sixteen tickets between them. Reading the WHOLE message would be
// worse: "see T-150" in prose would count as shipping T-150, and THAT error
// runs in the unsafe direction, reporting unshipped work as shipped. A declared
// scope is a claim; a mention is not.
//
// This is the ONE implementation of "which tickets does this message declare".
// `ticketIdsIn()` (a ref's whole history) and `check-ticket --message-file`
// (a single pending commit message, for the pre-commit hook) both call this —
// neither may grow its own copy of the parsing rules.
export function ticketIdsInMessage(msg) {
  const out = new Set();
  const lines = (msg || '').split('\n');
  const subject = lines.find(l => l.trim());
  const m = subject && subject.match(/^(T-\d+)/);
  if (m) out.add(m[1]);
  for (let i = 0; i < lines.length; i++) {
    if (!/^Tickets?\b/i.test(lines[i].trim())) continue;
    for (let j = i; j < lines.length && lines[j].trim(); j++) {
      for (const t of lines[j].match(/\bT-\d+\b/g) || []) out.add(t);
    }
  }
  return out;
}

// Which ticket ids a ref's history CLAIMS, across every commit on it.
export function ticketIdsIn(ref, cwd) {
  const out = new Set();
  for (const msg of gitOut(['log', ref, '--format=%B%x00'], cwd).split('\0')) {
    for (const id of ticketIdsInMessage(msg)) out.add(id);
  }
  return out;
}

function mainCheckout() {
  // --git-common-dir is shared by every worktree; --show-toplevel is not.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

// The tree you are standing in — which for a worktree is NOT the main checkout.
// The board deliberately resolves to one shared place; an archived ticket
// deliberately does not. See archive() for why the two differ.
function currentTree() {
  const top = execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  return top || mainCheckout();
}

// ── stale CLAUDE.md across worktrees (T-233) ────────────────────────────────
//
// A session started INSIDE a worktree reads THAT tree's CLAUDE.md, which can
// be weeks stale — the rules an agent inherits then depend silently on which
// checkout it happened to open on. This compares the main checkout's copy
// (canonical) against the current tree's copy and reports ONLY when they
// differ. Pure function, no logging, so it is unit-testable without a real
// worktree: pass any two directories holding a CLAUDE.md.
//
// Deliberately cheap: one readFileSync + one statSync per side, no git log
// walk. This runs on every SessionStart (via `status`), paid for forever.
export function claudeMdStaleness(mainRoot, localRoot) {
  if (resolve(mainRoot) === resolve(localRoot)) return null; // not a linked worktree
  const mainPath = join(mainRoot, 'CLAUDE.md');
  const localPath = join(localRoot, 'CLAUDE.md');

  let mainContent, mainMtime;
  try {
    mainContent = readFileSync(mainPath, 'utf8');
    mainMtime = statSync(mainPath).mtimeMs;
  } catch (e) {
    return { kind: 'unreadable', path: mainPath, message: e.message };
  }

  let localContent, localMtime;
  try {
    localContent = readFileSync(localPath, 'utf8');
    localMtime = statSync(localPath).mtimeMs;
  } catch (e) {
    return { kind: 'unreadable', path: localPath, message: e.message };
  }

  // The comparison that matters: are these actually two DIFFERENT files, read
  // from two DIFFERENT paths? (mainPath !== localPath is already guaranteed
  // by the resolve() check above — this is not comparing a file with itself.)
  if (mainContent === localContent) return null; // identical -> silent, always

  const mainLines = mainContent.split(/\r?\n/).length;
  const localLines = localContent.split(/\r?\n/).length;
  const newer = mainMtime === localMtime ? 'same modification time'
    : mainMtime > localMtime ? 'the main checkout is newer' : 'this worktree is newer';
  return { kind: 'differ', mainPath, localPath, mainLines, localLines, newer };
}

export function formatClaudeMdBanner(info) {
  if (!info) return '';
  if (info.kind === 'unreadable') {
    return `  CLAUDE.md: could not read ${info.path} (${info.message}) — skipping the staleness check.`;
  }
  return [
    '',
    "  STALE CLAUDE.md — this worktree's copy DIFFERS from the main checkout's.",
    `    main checkout (CANONICAL):  ${info.mainPath}  (${info.mainLines} lines)`,
    `    this worktree:               ${info.localPath}  (${info.localLines} lines)`,
    `    ${info.newer}. The rules you inherit here may be stale — read the main copy.`,
    '',
  ].join('\n');
}

export function boardPath() {
  if (process.env.ARSENAL_BOARD) return resolve(process.env.ARSENAL_BOARD);
  const repo = mainCheckout();
  return join(resolve(repo, '..'), 'inbound-platform-board', 'board.md');
}

export function ticketDir() {
  return join(dirname(boardPath()), 'tickets');
}

// ── Reading the board during the split ──────────────────────────────────────
//
// Tickets live in one file each (tickets/T-###.md). The flat board.md is kept
// because OTHER SESSIONS ARE STILL WRITING TO IT: a session started before the
// split has the old board.mjs in its context and will keep appending there.
// Reading only the new location would make their tickets invisible, which is
// precisely the failure the split exists to prevent.
//
// So both are read, the per-file version wins on a conflict, and a ticket found
// only in the flat file is reported as a STRAY rather than silently absorbed —
// a stray is evidence that a session has not picked up the change yet, and that
// is worth seeing rather than smoothing over.
function splitBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^### (T-\d+)\s*\|/);
    if (m) { cur = { id: m[1], lines: [l] }; out.push(cur); }
    else if (cur) cur.lines.push(l);
  }
  return out.map(b => ({ id: b.id, body: b.lines.join('\n').replace(/\s+$/, '') + '\n' }));
}

function stripFrontmatter(s) {
  return s.startsWith('---') ? s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n?/, '') : s;
}

export function readTickets() {
  const dir = ticketDir();
  const byId = new Map();
  let fileCount = 0;

  // A ticket must state its status in exactly ONE place: the body's
  // `- status:` line. Frontmatter carries only what the body cannot — created,
  // updated, claimed_by, claimed_at. If a `status:` reappears in frontmatter,
  // the ticket has two answers to "is anyone working on this" and which one
  // wins depends on how the reader got there. Flag it; never guess.
  const doubled = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(f => /^T-\d+\.md$/.test(f)).sort()) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const id = f.replace(/\.md$/, '');
      const body = stripFrontmatter(raw);
      const fm = (raw.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
      const fmStatus = (fm.match(/^status:\s*(\S+)/m) || [])[1];
      const bodyStatus = (body.match(/^-\s*status:\s*(\S+)/m) || [])[1];
      if (fmStatus) doubled.push({ id, fmStatus, bodyStatus: bodyStatus || '(none)' });
      byId.set(id, { id, body, file: join(dir, f), raw });
      fileCount++;
    }
  }

  const strays = [];
  const conflicts = [];
  const flat = boardPath();
  let header = '';
  if (existsSync(flat)) {
    const text = readFileSync(flat, 'utf8');
    const lines = text.split(/\r?\n/);
    const first = lines.findIndex(l => /^### T-\d+\s/.test(l));
    header = (first === -1 ? text : lines.slice(0, first).join('\n')).replace(/\s+$/, '');
    for (const b of splitBlocks(text)) {
      const own = byId.get(b.id);
      if (!own) { byId.set(b.id, { ...b, file: null }); strays.push(b.id); continue; }
      // Both places hold this ticket. If they AGREE it is just a leftover from
      // the split. If they DISAGREE, a session predating the split has edited
      // the flat copy and preferring the file silently discards that edit —
      // the exact lost update the split exists to prevent. Never resolve it
      // here: surface it, keep both, and let a person decide.
      if (own.body.trim() !== b.body.trim()) {
        conflicts.push({ id: b.id, file: own.file, flatBody: b.body });
      }
    }
  }
  const headerFile = join(dirname(flat), 'HEADER.md');
  if (!header && existsSync(headerFile)) header = readFileSync(headerFile, 'utf8').replace(/\s+$/, '');

  const tickets = [...byId.values()].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return { header, tickets, strays, conflicts, doubled, fileCount };
}

const TEMPLATE = `# Task board

Legend: \`todo\` | \`in-progress\` | \`blocked\` | \`tester-review\` |
\`human-review\` | \`staging\` | \`shipped\` | \`done\`

Format and protocol: see CLAUDE.md in the repo. Only the tester marks a ticket
\`done\`. Every ticket names the branch it belongs on and the worktree it is
being built in.

**This file is shared by every worktree and every session.** It is deliberately
outside the repo so no branch can fork it. Re-read it before you act on it —
another session may have written to it since you last looked.

<!-- Orchestrator writes tickets below this line -->
`;

function init() {
  const p = boardPath();
  if (existsSync(p)) return { path: p, created: false };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, TEMPLATE, 'utf8');
  return { path: p, created: true };
}

function requireBoard() {
  const p = boardPath();
  if (!existsSync(p)) {
    console.error(`\n  No board at ${p}\n  Run: node tools/board.mjs init\n`);
    process.exit(1);
  }
  return p;
}

// Archive keeps the history the shared file cannot: the live board is not in
// git, so a closed ticket's record would vanish when it is deleted. Closed
// tickets move into the repo, where they are committed and survive.
function archive(id) {
  if (!/^T-\d+$/.test(id || '')) {
    console.error('\n  Usage: node tools/board.mjs archive T-101\n');
    process.exit(1);
  }
  const p = requireBoard();
  const text = readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith(`### ${id} `) || l.trim() === `### ${id}`);
  if (start === -1) {
    console.error(`\n  ${id} is not on the board at ${p}\n`);
    process.exit(1);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ') || lines[i].startsWith('## ') || lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end).join('\n').replace(/\s+$/, '') + '\n';
  if (!/^-\s*status:\s*done\b/m.test(block)) {
    console.error(`\n  ${id} is not marked done. Only the tester closes a ticket.\n`);
    process.exit(1);
  }
  // Into the CURRENT tree, not the main checkout. Getting this wrong — which it
  // was, until 2026-09-23 — splits a ticket from the code it describes: the
  // record lands on whatever branch the main checkout happens to be sitting on
  // while the work sits on a feature branch, so the two are committed
  // separately, by different people, at different times. Written here, the
  // record rides its own branch and merges alongside the change it documents.
  //
  // The board itself still resolves to ONE shared path, and that asymmetry is
  // deliberate: a board is live state every tree must agree on, an archived
  // ticket is history that belongs with its commit.
  const out = join(currentTree(), 'tasks', 'done', `${id}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, block, 'utf8');
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(p, rest, 'utf8');
  console.log(`\n  archived ${id}\n  -> ${out}\n  removed from ${p}\n`);
}

// ── check-ticket ────────────────────────────────────────────────────────────
//
// The one reader every git hook calls (T-229, T-231): "does this ticket id
// exist on the board, and what is its status". A hook that parsed the board
// itself would be a second implementation of "which tickets exist" living in
// shell, drifting from this one the first time the board's format changes.
//
// Exit codes are deliberately distinct so a hook can tell "no such ticket"
// (1, a real problem with the commit) apart from "you called me wrong" (2, a
// bug in the hook itself) apart from "you declared nothing at all" (3, a
// different message a hook should give the human). `status` above must never
// exit 2 or throw because it gates session start; check-ticket is the
// opposite — it gates a commit, so a malformed call SHOULD fail loudly.
function statusOf(ticket) {
  return (ticket.body.match(/^-\s*status:\s*(\S+)/m) || [])[1] || '(unknown)';
}

function checkTicketOne(id) {
  if (!/^T-\d+$/.test(id || '')) {
    console.error('\n  Usage: node tools/board.mjs check-ticket T-###\n');
    process.exit(2);
  }
  const { tickets } = readTickets();
  const t = tickets.find(x => x.id === id);
  if (!t) {
    console.error(`  ${id} is not on the board`);
    process.exit(1);
  }
  console.log(`${id} ${statusOf(t)}`);
  process.exit(0);
}

function checkTicketMessageFile(file) {
  if (!file) {
    console.error('\n  Usage: node tools/board.mjs check-ticket --message-file <path>\n');
    process.exit(2);
  }
  let msg;
  try {
    msg = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`\n  cannot read message file: ${file}\n  ${e.message}\n`);
    process.exit(2);
  }
  const ids = [...ticketIdsInMessage(msg)];
  if (!ids.length) {
    console.error('  the commit message declares no ticket id');
    process.exit(3);
  }
  const { tickets } = readTickets();
  const byId = new Map(tickets.map(t => [t.id, t]));
  const missing = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) { missing.push(id); continue; }
    console.log(`${id} ${statusOf(t)}`);
  }
  if (missing.length) {
    console.error(`  not on board: ${missing.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

// Batch mode (T-231): the pre-push hook checks a whole RANGE of unpushed
// commits, and one `node` startup per commit was measured at ~350ms each --
// ~7s on a 21-commit push, ~17s at 50. That is slow enough that people reach
// for ALLOW_UNVERIFIED_PUSH out of impatience, which is exactly how a guard
// decays into a banner nobody reads.
//
// This does NOT grow a second id parser: it loops the ONE existing
// `ticketIdsInMessage()` once per segment (a segment is one commit's
// message). Concatenating N messages into a single call was considered and
// REFUSED -- `ticketIdsInMessage()` reads only the FIRST non-blank line as
// the subject, so concatenation would see only commit #1's subject id and
// silently drop every other commit's subject-only declaration. That is an
// unsafe-direction regression dressed as an optimisation: work would read as
// declared-and-checked when it was never looked at.
//
// Two ways in, both ending up as a list of {sha, msg} segments:
//   --message-file <path> [--message-file <path> ...]   repeatable flag
//   --message-files-list <path-to-a-NUL-delimited-file-of-paths>
// A segment's sha is the file's basename -- the caller (pre-push) names each
// per-commit message file after the commit it came from, so the hook can
// attribute an offending id back to the sha that introduced it without this
// file parsing anything shell-side.
function checkTicketMessageFiles(paths) {
  const segments = [];
  for (const p of paths) {
    let msg;
    try {
      msg = readFileSync(p, 'utf8');
    } catch (e) {
      console.error(`\n  cannot read message file: ${p}\n  ${e.message}\n`);
      process.exit(2);
    }
    segments.push({ sha: basename(p), msg });
  }
  const { tickets } = readTickets();
  const byId = new Map(tickets.map(t => [t.id, t]));
  const missing = new Set();
  for (const { sha, msg } of segments) {
    for (const id of ticketIdsInMessage(msg)) {
      const t = byId.get(id);
      if (!t) { missing.add(id); continue; }
      console.log(`${id} ${statusOf(t)} ${sha}`);
    }
  }
  if (missing.size) {
    console.error(`  not on board: ${[...missing].join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

function checkTicket(args) {
  const hasList = args.includes('--message-files-list');
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--message-file') {
      paths.push(args[++i]);
    } else if (args[i] === '--message-files-list') {
      const manifest = args[++i];
      let raw;
      try {
        raw = readFileSync(manifest, 'utf8');
      } catch (e) {
        console.error(`\n  cannot read message list: ${manifest}\n  ${e.message}\n`);
        process.exit(2);
      }
      for (const p of raw.split('\0')) if (p) paths.push(p);
    }
  }
  if (!paths.length) { checkTicketOne(args[0]); return; }
  // Exactly one --message-file and no --message-files-list: the ORIGINAL,
  // single-message call every existing caller (commit-msg) already uses.
  // Its exit codes (0/1/2/3) and "no ticket declared" behaviour are load
  // -bearing for that hook and are left untouched.
  if (paths.length === 1 && !hasList) { checkTicketMessageFile(paths[0]); return; }
  checkTicketMessageFiles(paths);
}

// ── mine ────────────────────────────────────────────────────────────────────
//
// The human's own queue, and nothing else, ever: human-review, staging,
// blocked (T-232). What classifies as "mine" and what English sentence
// explains why lives in board-queue.mjs's classifyMine — the SAME function
// board-sweep.mjs's WAITING ON YOU / NEEDS A PERSON categories call, so this
// view and the dashboard cannot drift apart. This file only adds the git
// lookup (claimsOnFactory, below) and the printing.
function claimsOnFactory() {
  const cache = new Map();
  return br => {
    if (!br) return new Set();
    if (!cache.has(br)) cache.set(br, ticketIdsIn(br));
    return cache.get(br);
  };
}

function mine() {
  let read;
  try {
    read = readTickets();
  } catch (e) {
    console.log(`  mine: board not readable (${e.message})`);
    return;
  }
  const items = buildMineQueue(read.tickets, { claimsOn: claimsOnFactory() });
  if (!items.length) {
    console.log('\n  Nothing waiting on you. 0 tickets.\n');
    return;
  }

  // Group the human's own queue by FEATURE (T-273): a feature header line
  // first (slug, statusLine, count, YOU:), its waiting tickets indented
  // beneath, so ~55 items read as ~8 features. `reachesQueue` (T-271) is
  // the one gate deciding whether `dev-team` shows up here at all -- not
  // re-implemented locally.
  const parsed = read.tickets.map(parseTicket);
  const grouped = groupByFeature(parsed);
  const bySlug = new Map(grouped.map(f => [f.slug, f]));
  const byId = new Map(parsed.map(p => [p.id, p]));
  const itemsBySlug = new Map();
  const noFeature = [];
  for (const it of items) {
    const pt = byId.get(it.id);
    const slug = pt ? featureOf(pt) : '';
    const f = slug ? bySlug.get(slug) : null;
    if (!slug || !f) { noFeature.push(it); continue; }
    if (!reachesQueue(f)) continue; // e.g. dev-team with nothing owed to the human
    if (!itemsBySlug.has(slug)) itemsBySlug.set(slug, []);
    itemsBySlug.get(slug).push(it);
  }

  const printItem = it => {
    const age = it.ageMs == null ? 'unknown' : `${formatAge(it.waitingDate)} (${it.waitingLabel})`;
    console.log(`    ${it.id}  ${it.title || '(untitled)'}  [${it.branch || 'no branch'}]`);
    console.log(`           owed:    ${it.why} — ${it.action}`);
    console.log(`           waiting: ${age}`);
  };

  console.log('');
  let shownTickets = 0;
  let shownFeatures = 0;
  for (const slug of [...itemsBySlug.keys()].sort()) {
    const its = itemsBySlug.get(slug);
    // T-273 (reopened): the header must describe EXACTLY the `its` list
    // printed beneath it, not the feature's whole ticket set — so derive
    // the statusLine/action from the SAME subset (parsed tickets matching
    // its ids), never from `f` (bySlug.get(slug)).tickets. This is the only
    // reason `statusLineForSubset`/`nextActionForSubset` exist: `f.statusLine`
    // /`f.nextAction` are computed over ALL of the feature's tickets and
    // would disagree with `its.length` for any feature with shipped or
    // in-progress work alongside what's owed.
    const subset = its.map(it => byId.get(it.id)).filter(Boolean);
    const statusLine = statusLineForSubset(subset);
    const nextAction = nextActionForSubset(subset);
    const action = nextAction === '--' ? '--' : `YOU: ${nextAction}`;
    console.log(`  ${slug}  ${statusLine}  ${its.length} ticket${its.length === 1 ? '' : 's'}  ${action}`);
    for (const it of its) printItem(it);
    console.log('');
    shownTickets += its.length;
    shownFeatures++;
  }
  if (noFeature.length) {
    console.log(`  (no feature)  ${noFeature.length} ticket${noFeature.length === 1 ? '' : 's'}`);
    for (const it of noFeature) printItem(it);
    console.log('');
    shownTickets += noFeature.length;
    shownFeatures++;
  }
  console.log(`  ${shownTickets} ticket(s) waiting on you across ${shownFeatures} feature(s).\n`);
}

// ── status ──────────────────────────────────────────────────────────────────
//
// Written for the SessionStart hook, which is why it must NEVER exit 2 and
// never throw: exit 2 blocks the session from starting at all, and an
// unreadable board is not a reason to stop someone working. Every failure path
// here prints something useful and exits 0.
//
// Its stdout goes into the model's context before the first prompt, so it is
// the one place a rule reaches a session that has not read anything yet. Keep
// it short — this is paid for on every session, forever.
function status() {
  const p = boardPath();
  let read;
  try {
    read = readTickets();
  } catch {
    console.log(`\n  BOARD  not readable at ${p}`);
    console.log('  Run: node tools/board.mjs init\n');
    return;
  }
  if (!read.tickets.length && !existsSync(p)) {
    console.log(`\n  BOARD  not found at ${p}`);
    console.log('  Run: node tools/board.mjs init\n');
    return;
  }

  // Launch-location safety (T-233): if this session started inside a LINKED
  // worktree, its CLAUDE.md may be weeks stale against the main checkout's.
  // Silent when identical or when not a worktree at all — a banner that
  // always fires is a banner nobody reads. Never let this block session
  // start: any failure here is one honest line, never a throw.
  try {
    const banner = formatClaudeMdBanner(claudeMdStaleness(mainCheckout(), currentTree()));
    if (banner) console.log(banner);
  } catch (e) {
    console.log(`  CLAUDE.md: staleness check unavailable (${e.message})`);
  }

  // The human's own queue, pinned at the TOP — but ONLY when there is one.
  // A banner that always fires is a banner nobody reads (T-232). This must
  // never throw or slow the hook down, and it is paid for on every session
  // start forever, so it skips the git lookup entirely (a no-op claimsOn):
  // the pin only needs WHICH tickets and HOW MANY of each kind, not the
  // "committed on <branch> vs still uncommitted" nuance in the why-text —
  // that finer detail is what `node tools/board.mjs mine` is for, and only
  // runs when a human actually asks for it. Measured: with the git lookup
  // this pin cost ~300ms extra on this board (multiple distinct branches,
  // each a `git log` walk); without it, status is back to its old speed.
  try {
    const items = buildMineQueue(read.tickets, { claimsOn: () => new Set() });
    if (items.length) {
      // T-273: the pin stops counting TICKETS and reads in FEATURES, using
      // the same groupByFeature/reachesQueue as `mine` and `features` (T-271)
      // -- no second copy of the grouping or gating rule. `dev-team` only
      // shows up here when reachesQueue says something in it is actually
      // owed to the human (human-review/staging/blocked), same as `mine`.
      const parsed = read.tickets.map(parseTicket);
      const grouped = groupByFeature(parsed);
      const waitingIds = new Set(items.map(i => i.id));
      const featuredIds = new Set();
      const featureNames = [];
      for (const f of grouped) {
        for (const t of f.tickets) featuredIds.add(t.id);
        if (!reachesQueue(f)) continue;
        if (f.tickets.some(t => waitingIds.has(t.id))) featureNames.push(f.slug);
      }
      if (items.some(i => !featuredIds.has(i.id))) featureNames.push('(no feature)');

      if (featureNames.length) {
        // Cap the name list — a wall of feature names is not a pin either.
        // The pin's job is to make the human ASK; `mine` holds the detail.
        const shown = featureNames.slice(0, 5);
        const nameText = featureNames.length > 5
          ? `${shown.join(', ')}, and ${featureNames.length - 5} more`
          : shown.join(', ');
        console.log(`\n  YOUR QUEUE  ${featureNames.length} feature(s) waiting on you — ${nameText}`);
        console.log('  node tools/board.mjs mine   for the full list, what each owes, and how long it has waited\n');
      }
    }
  } catch { /* never let this block session start — see hook contract below */ }

  const text = read.tickets.map(t => t.body).join('\n');
  const lines = text.split(/\r?\n/);
  const tickets = read.tickets.length;
  const counts = {};
  const legacy = [];
  for (const t of read.tickets) {
    const m = t.body.match(/^-\s*status:\s*(\S+)/m);
    if (!m) continue;
    counts[m[1]] = (counts[m[1]] || 0) + 1;
    if (m[1] === 'review') legacy.push(t.id);
  }
  const n = k => counts[k] || 0;
  // `review` stays in the order, last, so a ticket still carrying the retired
  // word shows up in the counts rather than silently vanishing from them.
  const order = ['todo', 'in-progress', 'blocked', 'tester-review',
                 'human-review', 'staging', 'shipped', 'done', 'review'];
  const parts = order.filter(k => n(k)).map(k => `${n(k)} ${k}`);

  const out = [];
  out.push(`  BOARD  ${tickets} tickets — ${parts.join(' · ')}`);

  // Each warning below is here because it actually happened, not because it
  // might. Say nothing when there is nothing to say: a banner that always warns
  // is a banner nobody reads.
  if (n('tester-review')) {
    out.push(`  ${n('tester-review')} at tester-review — finished work waiting on A TESTER.`);
    out.push('  ONLY THE TESTER CLOSES A TICKET. Dispatch one before opening new work;');
    out.push('  unfiled finished work is how the board stopped shrinking on 2026-09-23.');
  }
  if (n('human-review')) {
    out.push(`  ${n('human-review')} at human-review — a tester PASSED these; they wait on the`);
    out.push('  human to commit and merge. No agent can move them, and dispatching a');
    out.push('  tester at one re-verifies work that is already verified.');
  }
  if (n('staging')) {
    out.push(`  ${n('staging')} on staging — deployed, waiting on the human to test it there.`);
  }
  // The only status an agent can clear without the human: the work is live,
  // and what remains is housekeeping.
  if (n('shipped')) {
    out.push(`  ${n('shipped')} shipped — live in production, worktree not yet cleaned.`);
    out.push('  This is the one late status an agent CAN clear: remove the worktree');
    out.push('  (node tools/worktree.mjs done <branch>) and only then set done.');
  }
  // The rename's own failure mode, made loud. A session that missed the cutover
  // writes the old word, and a status the tools do not know is a status nobody
  // chases. Name the tickets so the fix is a lookup and not a hunt.
  if (n('review')) {
    out.push(`  ${n('review')} still on the RETIRED status "review", split on 2026-09-24 into`);
    out.push('  tester-review (waiting on a tester) and human-review (waiting on the');
    out.push('  human). Read each and set the one that is TRUE — do not guess:');
    out.push(`    ${legacy.join(', ')}`);
  }
  // An uninstalled guard is worse than no guard: the file is visibly present,
  // so everyone assumes it is running.
  const hooksPath = gitOut(['config', '--get', 'core.hooksPath']);
  if (hooksPath !== '.githooks') {
    out.push('  GUARD NOT INSTALLED — direct commits to staging/main are not being');
    out.push('  refused in this clone. The hook file exists but nothing is running it:');
    out.push('     git config core.hooksPath .githooks');
  }
  if (n('blocked')) {
    out.push(`  ${n('blocked')} blocked. Blocked means a human must act; no agent can clear it.`);
  }
  if (lines.length > 900) {
    out.push(`  Board is ${lines.length} lines. Large enough that a read may be TRUNCATED —`);
    out.push('  if you are about to act on what you read, re-read the part you need.');
  }

  out.push('');
  out.push('  You are NOT the orchestrator. If the human has given you a goal, a feature');
  out.push('  or a bug, dispatch the `orchestrator` agent before you write any code.');
  out.push('  It is a sub-agent and runs only when dispatched; nothing warns you when it');
  out.push('  is skipped. See CLAUDE.md. Read the board: node tools/board.mjs show');
  out.push('');

  console.log('\n' + out.join('\n'));
}

// ── features ─────────────────────────────────────────────────────────────────
//
// The owner thinks in features, not tickets. One line per feature, nothing
// else — no ticket ids, no per-ticket detail. All the grouping and status
// rules live in board-features.mjs (T-271); this function only reads the
// board, parses tickets, and prints. It MAY do git work (readTickets() does
// not shell to git itself, and neither does groupByFeature), unlike `status`,
// which must stay git-free.
//
// Tickets with no `- feature:` line are collected under one trailing
// `(no feature)` line so they stay visible without polluting the per-feature
// list above it.
// `board-features.mjs` caps a SINGLE status/action string at 100 chars so
// one feature's line cannot run away. That is not the same problem as this
// table's column alignment: padding every row's status column to the GLOBAL
// max across all 16 rows drags a 15-char row like `crm-column-resize` out to
// whatever the busiest feature (e.g. `sms-backend`) needs, and every row
// wraps. So the status column here gets its OWN, smaller display cap: short
// rows are padded only to the narrowest width that fits every row UNDER the
// cap (never to another row's length), and any row whose real content
// exceeds the cap is truncated with an ellipsis instead of stretching the
// whole table. Exported (not inlined in `features()`) so this column-width
// behaviour can be tested directly against a small fixed rows array, without
// going through the live board.
export const STATUS_DISPLAY_CAP = 40;

export function renderFeatureRows(rows) {
  if (!rows.length) return [];
  const truncate = (s, capN) => (s.length <= capN ? s : `${s.slice(0, capN - 1)}…`);

  const slugW = Math.max(...rows.map(r => r.slug.length));
  const statusW = Math.min(Math.max(...rows.map(r => r.status.length)), STATUS_DISPLAY_CAP);
  const countW = Math.max(...rows.map(r => r.count.length));
  return rows.map(r => {
    const status = truncate(r.status, statusW);
    return `${r.slug.padEnd(slugW)}  ${status.padEnd(statusW)}  ${r.count.padEnd(countW)}  ${r.action}`.replace(/\s+$/, '');
  });
}

function features() {
  let read;
  try {
    read = readTickets();
  } catch (e) {
    console.log(`  features: board not readable (${e.message})`);
    return;
  }
  const parsed = read.tickets.map(parseTicket);
  const grouped = groupByFeature(parsed);
  const unfeatured = parsed.filter(t => !t.feature).length;

  const rows = grouped.map(f => ({
    slug: f.slug,
    status: f.statusLine,
    count: `${f.tickets.length} ticket${f.tickets.length === 1 ? '' : 's'}`,
    action: f.nextAction === '--' ? '--' : `YOU: ${f.nextAction}`,
  }));
  if (unfeatured) {
    rows.push({
      slug: '(no feature)',
      status: '',
      count: `${unfeatured} ticket${unfeatured === 1 ? '' : 's'}`,
      action: '--',
    });
  }

  for (const line of renderFeatureRows(rows)) {
    console.log(line);
  }
}

// Reserve the next free id by CREATING the file, not by returning a number.
// `wx` fails if the path exists, so two callers racing cannot both win — the
// loser retries against a now-higher maximum. Returning a number and trusting
// the caller to use it promptly is what collided three times on 2026-09-23.
function nextId() {
  const dir = ticketDir();
  mkdirSync(dir, { recursive: true });
  const { tickets } = readTickets();
  let n = tickets.reduce((m, t) => Math.max(m, Number(t.id.slice(2)) || 0), 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `T-${++n}`;
    const file = join(dir, `${id}.md`);
    try {
      // NO `status:` in the frontmatter. The body's `- status:` line is the
      // single source, because that is what every tool already reads. A ticket
      // carrying both would let one be updated and not the other, and then it
      // reads in-progress to one reader and todo to another with no error and
      // nothing to say which is current — two meanings for one observable,
      // which is the failure class this whole split exists to remove.
      // Frontmatter carries only what the body CANNOT.
      writeFileSync(file, [
        '---',
        `id: ${id}`,
        `created: ${new Date().toISOString()}`,
        `updated: ${new Date().toISOString()}`,
        'claimed_by:',
        'claimed_at:',
        '---',
        '',
        `### ${id} | (untitled — the caller must fill this in)`,
        '- owner:',
        '- branch:',
        '- worktree:',
        '- status: todo',
        '- acceptance:',
        '- notes:',
        '',
      ].join('\n'), { encoding: 'utf8', flag: 'wx' });
      return { id, file };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;   // someone else took it; try the next
    }
  }
  throw new Error('could not reserve an id after 50 attempts');
}

// board.mjs is imported as a module by board-sweep and board-dashboard, so the
// CLI must not run on import. Without this guard, importing it printed the help
// text into their output and, worse, would run whatever argv happened to hold.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const cmd = isMain ? process.argv[2] : '__imported__';
if (cmd === 'tickets' || cmd === 'path') {
  // `path` used to print board.md. That file is retired, and a caller following
  // the old output would write somewhere nothing reads — which a peer session
  // caught before any agent did. Both now print the ticket directory.
  console.log(ticketDir());
} else if (cmd === 'next-id') {
  const r = nextId();
  console.log(`${r.id}\n${r.file}`);
} else if (cmd === 'status') {
  // Belt and braces: the hook contract says exit 2 kills the session, so no
  // failure in here may ever reach the shell as a throw.
  try { status(); } catch (e) { console.log(`  BOARD  status unavailable (${e.message})`); }
  process.exit(0);
} else if (cmd === 'show') {
  const { header, tickets, strays } = readTickets();
  console.log(header + '\n\n' + tickets.map(t => t.body).join('\n'));
  if (strays.length) {
    console.log(`\n<!-- ${strays.length} ticket(s) still live only in the flat board.md, not in tickets/:`);
    console.log(`     ${strays.join(', ')}`);
    console.log('     A session that predates the split is still writing there. Harmless to read,');
    console.log('     but it means that session has not picked up the change. -->');
  }
} else if (cmd === 'init') {
  const r = init();
  console.log(`\n  ${r.created ? 'created' : 'already there'}  ${r.path}\n`);
} else if (cmd === 'archive') {
  archive(process.argv[3]);
} else if (cmd === 'check-ticket') {
  checkTicket(process.argv.slice(3));
} else if (cmd === 'mine') {
  mine();
} else if (cmd === 'features') {
  features();
} else if (isMain) {
  console.log(`
  node tools/board.mjs tickets         print the ticket DIRECTORY
  node tools/board.mjs path            same — kept for callers that used it
  node tools/board.mjs show            print every ticket, concatenated
  node tools/board.mjs status          counts, warnings, and the standing rule
  node tools/board.mjs mine            ONLY what is waiting on the human:
                                        human-review, staging, blocked
  node tools/board.mjs features        ONE LINE PER FEATURE: status, ticket
                                        count, and what you owe it (or "--")
  node tools/board.mjs next-id         reserve the next id by creating its file
  node tools/board.mjs archive T-101   move a done ticket into tasks/done/
  node tools/board.mjs check-ticket T-101              exit 0/1/2, prints status
  node tools/board.mjs check-ticket --message-file f   checks every id a commit declares
  node tools/board.mjs check-ticket --message-file f1 --message-file f2 ...
                                                        batch: prints "id status <basename>"
  node tools/board.mjs check-ticket --message-files-list list.txt
                                                        same, paths read from a NUL-delimited file

  The board is one file per ticket, shared by every worktree, outside the repo:
  ${ticketDir()}

  There is no board.md any more. It was retired at the split and anything
  written to it is invisible. Edit a ticket's own file; never invent an id.
`);
}
