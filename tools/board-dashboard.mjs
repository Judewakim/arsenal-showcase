#!/usr/bin/env node
/**
 * board-dashboard.mjs — a read-only window on the agent team.
 *
 *   node tools/board-dashboard.mjs                 write dashboard.html
 *   node tools/board-dashboard.mjs --out x.html    somewhere else
 *   node tools/board-dashboard.mjs --json          print the data, write nothing
 *
 * NOT an editor and not a control panel. It answers four questions that are
 * currently only answerable by reading a 1,400-line file: what is in flight,
 * what is waiting on ME, what is stalled, and is the board still growing.
 *
 * Self-contained output: the data is baked into the HTML at generation time, so
 * the file can be opened from disk or published anywhere without a server. That
 * also means it is a SNAPSHOT. Re-run it to refresh. A live view would need
 * something running, and nothing here should need something running.
 */
import { readTickets, ticketDir, ticketIdsIn, gitOut } from './board.mjs';
import { groupByFeature, featureOf } from './board-features.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const here = dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Read through board.mjs, not by opening the board. When the board became one
// file per ticket, this tool and the sweep both broke, because each carried its
// own copy of "where the board is and how to parse it" and neither was updated
// with the storage. One reader, one place to fix.
const boardPath = ticketDir();
const rawTicketFiles = readTickets();
const raw = rawTicketFiles.tickets.map(t => t.body).join('\n');
const lines = raw.split(/\r?\n/);

// ── Parse the board ─────────────────────────────────────────────────────────
//
// Deliberately forgiving. The board is written by many agents and one human,
// and a ticket with a malformed field should show up looking wrong rather than
// vanish from the dashboard — a missing row is how you stop trusting a view.
const tickets = [];
let cur = null;
for (const l of lines) {
  const h = l.match(/^### (T-\d+)\s*\|\s*(.+?)\s*$/);
  if (h) {
    cur = { id: h[1], num: Number(h[1].slice(2)), title: h[2], status: 'unknown', owner: '', branch: '', worktree: '', dependsOn: '', feature: '', noteLines: 0 };
    tickets.push(cur);
    continue;
  }
  if (!cur) continue;
  if (/^### /.test(l)) { cur = null; continue; }
  const f = l.match(/^-\s*([a-z-]+):\s*(.*)$/i);
  if (f) {
    const k = f[1].toLowerCase();
    const v = f[2].trim();
    if (k === 'status' && cur.status === 'unknown') cur.status = v.split(/\s/)[0];
    else if (k === 'owner' && !cur.owner) cur.owner = v;
    else if (k === 'branch' && !cur.branch) cur.branch = v;
    else if (k === 'worktree' && !cur.worktree) cur.worktree = v;
    else if (k === 'depends-on' && !cur.dependsOn) cur.dependsOn = v;
    else if (k === 'feature' && !cur.feature) cur.feature = v;
  }
  if (l.trim()) cur.noteLines++;
}

// ── Worktrees, and whether anything is uncommitted in them ──────────────────
//
// An uncommitted worktree is the interesting case: work that exists in exactly
// one place, on one machine, with no copy. A ticket can be closed while its
// code is still only here.
const worktrees = [];
for (const block of git(['worktree', 'list', '--porcelain']).split('\n\n')) {
  const path = (block.match(/^worktree (.+)$/m) || [])[1];
  if (!path) continue;
  const branch = ((block.match(/^branch (.+)$/m) || [])[1] || '(detached)').replace('refs/heads/', '');
  const dirty = git(['status', '--porcelain'], path).split('\n').filter(Boolean).length;
  const ahead = git(['rev-list', '--count', `staging..HEAD`], path);
  worktrees.push({ path, branch, dirty, ahead: Number(ahead || 0) });
}

const byStatus = {};
for (const t of tickets) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

// ── Features ─────────────────────────────────────────────────────────────
//
// One line per feature, above the ticket table — the owner thinks in
// features, not tickets. All grouping and status-derivation rules live in
// board-features.mjs (T-271); this file only feeds it the parsed tickets and
// renders what comes back. No status rule is re-derived here.
const features = groupByFeature(tickets);
const unfeaturedCount = tickets.filter(t => !t.feature).length;
// Keyed through the same canonical alias table groupByFeature uses (T-271's
// FEATURE_ALIASES), not the raw `- feature:` string — otherwise the pipeline
// row and the features section could name the same ticket under two
// different slugs (e.g. "sms-fire" here vs "sms-backend" above).
const featureByTicket = new Map(tickets.map(t => [t.id, featureOf(t)]));

// ── Where the work actually IS ──────────────────────────────────────────────
//
// The board cannot answer "what is deployed and waiting on me". Ticket status
// is self-reported, and in practice nothing ever sets `staging` — so that
// column reads empty while twenty-one commits sit on the staging site awaiting
// promotion. Git can answer it, and these are the refs Amplify actually deploys
// from: origin/main IS production, origin/staging IS the staging site.
//
// The distinction that matters and is easy to miss: a commit on a LOCAL branch
// has deployed nothing, however green its tests are. Amplify builds from the
// remote. So "committed" and "in an environment" are different claims, and the
// third row below exists to stop them being read as one.
function range(from, to, label, meaning) {
  const has = r => gitOut(['rev-parse', '--verify', '--quiet', r]);
  if (!has(from) || !has(to)) return { label, meaning, missing: `${has(from) ? to : from} does not exist`, commits: [], ids: [] };
  const commits = gitOut(['log', `${from}..${to}`, '--format=%h\u0001%s'])
    .split('\n').filter(Boolean)
    .map(l => { const [sha, subject] = l.split('\u0001'); return { sha, subject }; });
  const ids = [...ticketIdsIn(`${from}..${to}`)]
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  // Keyed by feature, not ticket: a slug for every id that carries a
  // `- feature:` line, plus one trailing bucket for ids that don't, so a
  // deployed ticket is never silently dropped from this row.
  const featureSlugs = [...new Set(ids.map(id => featureByTicket.get(id)).filter(Boolean))].sort();
  const unfeaturedIds = ids.filter(id => !featureByTicket.get(id));
  return { label, meaning, from, to, commits, ids, featureSlugs, unfeaturedIds };
}

const pipeline = [
  range('origin/main', 'origin/staging',
    'On staging, waiting on you',
    'Deployed to the staging site and not yet in production. Test it on the staging URL, then promote to main.'),
  range('origin/staging', 'staging',
    'Committed here, in no environment',
    'On your local staging branch but never pushed, so Amplify has not built it. It is NOT on the staging site.'),
];

// The sweep answers the one question the board cannot answer about itself:
// which of these has stopped moving, and why. Run rather than reimplemented,
// so the dashboard and the command-line sweep can never disagree.
let sweep = [];
try {
  const out = execFileSync('node', [join(here, 'board-sweep.mjs'), '--json'], { encoding: 'utf8' });
  sweep = JSON.parse(out).findings || [];
} catch (e) {
  console.error(`  ! sweep unavailable (${e.message.split('\n')[0]}) — the page will say so`);
  sweep = null;
}

const data = {
  generatedAt: new Date().toISOString(),
  boardPath,
  boardLines: lines.length,
  boardBytes: Buffer.byteLength(raw, 'utf8'),
  tickets,
  features,
  unfeaturedCount,
  worktrees,
  byStatus,
  sweep,
  pipeline,
};

if (argv.includes('--json')) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const out = opt('out', 'dashboard.html');
const tpl = readFileSync(join(here, 'board-dashboard.template.html'), 'utf8');
// JSON.stringify twice would double-escape; instead guard the one sequence that
// can close the script tag early and break the page silently.
const payload = JSON.stringify(data).replace(/</g, '\\u003c');
writeFileSync(out, tpl.replace('/*__DATA__*/null', payload), 'utf8');

console.log(`\n  wrote    ${out}`);
console.log(`  board    ${data.boardLines} lines, ${(data.boardBytes / 1024).toFixed(0)}KB`);
console.log(`  tickets  ${tickets.length} — ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
console.log(`  features ${features.length}${unfeaturedCount ? ` (+${unfeaturedCount} unfeatured ticket(s))` : ''}`);
console.log(`  trees    ${worktrees.length}, ${worktrees.filter(w => w.dirty).length} with uncommitted work`);
for (const p of pipeline) {
  console.log(`  ${p.label.padEnd(34)} ${p.commits.length} commit(s), ${p.ids.length} ticket(s)`);
}
console.log(`  stalled  ${sweep === null ? 'sweep unavailable' : `${sweep.length} finding(s)`}\n`);
