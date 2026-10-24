#!/usr/bin/env node
/**
 * worktree.mjs — one git worktree per branch, so several agents (or you and an
 * agent) can work on different branches at the same time without switching the
 * checkout out from under each other.
 *
 *   node tools/worktree.mjs new  <branch> [--from <base>] [--ticket T-###]...
 *   node tools/worktree.mjs list
 *   node tools/worktree.mjs done <branch> [--delete-branch]
 *
 * `--ticket T-###` verifies the ticket exists on the shared board BEFORE
 * anything is created — a bad id refuses and leaves no directory behind —
 * then, once the tree is built, stamps that ticket's file: status
 * `in-progress`, `worktree:` set to the path just created, and frontmatter
 * `claimed_by` / `claimed_at` filled in. Without `--ticket` the tree is still
 * built, but nothing on the board will show it, and this prints loudly.
 *
 * Why this exists rather than a bare `git worktree add`: a fresh worktree does
 * NOT contain amplify_outputs.json. That file is gitignored, and without it the
 * app cannot boot and every GraphQL call fails with FieldUndefined — which
 * looks like a code bug and is not one. `new` copies it in and installs
 * dependencies so the tree is usable the moment it exists.
 *
 * And why `done` does the file deletion itself: on Windows `git worktree
 * remove` drops the administrative link first and deletes the files second,
 * and the second half fails on node_modules (long paths, open handles). That
 * leaves a directory on disk that git no longer tracks — an orphan that made
 * an earlier version of this script die with "not a git repository". Both
 * halves are handled below.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { readTickets, ticketDir } from './board.mjs';

const SIBLING = 'inbound-platform-wt';   // ../inbound-platform-wt/<branch>
const CARRY = ['amplify_outputs.json'];  // gitignored files a tree needs to run

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function run(cmd, args, cwd) {
  // npm on Windows is a .cmd shim, and since CVE-2024-27980 Node refuses to
  // spawn one directly: execFileSync('npm.cmd', …) throws EINVAL. So npm has
  // to go through a shell here.
  //
  // This is only safe because every argument npm is ever given below is a
  // hardcoded constant. NEVER interpolate a path or anything user-supplied
  // into this string — that is the injection the shell option invites. git
  // keeps the argv form precisely because it IS handed paths.
  if (process.platform === 'win32' && cmd === 'npm') {
    execSync([cmd, ...args].join(' '), { cwd, stdio: 'inherit' });
    return;
  }
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function die(msg) {
  console.error('\n  x ' + msg + '\n');
  process.exit(1);
}

const norm = (p) => p.replace(/\\/g, '/');

// --show-toplevel is per-tree: run FROM a worktree, it returns that worktree,
// which put the sibling directory one level too deep
// (..\inbound-platform-wt\inbound-platform-wt\<branch>) because every level
// of nesting re-added `..\SIBLING`. --git-common-dir is shared by every
// worktree of a repo, so its parent is always the ONE main checkout,
// regardless of which tree this script was launched from. Same fix as
// board.mjs's mainCheckout() (T-233) — identical root cause, identical fix.
const repoRoot = git(['rev-parse', '--show-toplevel']);
function mainCheckoutRoot() {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return dirname(common);
}
const treeRoot = resolve(mainCheckoutRoot(), '..', SIBLING);
const slug = (b) => b.replace(/[^\w.-]+/g, '-');
const pathFor = (b) => join(treeRoot, slug(b));

function branchExists(b) {
  try {
    git(['rev-parse', '--verify', 'refs/heads/' + b]);
    return true;
  } catch {
    return false;
  }
}

function defaultBase() {
  return branchExists('staging') ? 'staging' : 'main';
}

function registeredWorktrees() {
  return git(['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => norm(l.slice('worktree '.length)));
}

// Something identifying enough to trace a claim back to whoever made it —
// branch + host + local user. Good enough to answer "who has this," not
// meant to be a real identity system.
function claimant(branch) {
  let user = 'unknown';
  try { user = userInfo().username; } catch { /* no /etc/passwd entry, etc. */ }
  return branch + '@' + hostname() + ' (' + user + ')';
}

// Verify every --ticket id exists on the board BEFORE anything is created.
// readTickets() is the same reader board.mjs itself uses, so "exists" here
// means exactly what `node tools/board.mjs show` would show you — not a
// guess based on a filename pattern.
function verifyTickets(ids) {
  if (!ids.length) return;
  const { tickets } = readTickets();
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    die('unknown ticket(s): ' + missing.join(', ') +
        '\n    Creating no tree. Check the id with: node tools/board.mjs show');
  }
  // A ticket can exist only as a leftover in the flat board.md (a "stray" —
  // see board.mjs), which has no per-file ticket to stamp. Refuse rather than
  // silently skip the stamp.
  const strayOnly = ids.filter((id) => !byId.get(id).file);
  if (strayOnly.length) {
    die('ticket(s) exist only in the legacy flat board.md, with no per-file ' +
        'ticket to stamp: ' + strayOnly.join(', ') + '\n    Creating no tree.');
  }
}

// Stamp a claimed ticket on the shared board. Today these fields are
// hand-written and usually are not, which is why the board shows work that
// is not really in flight and misses work that is (T-230). Status lives in
// exactly one place — the body's `- status:` line — so this never touches a
// frontmatter `status:` key.
function stampTicket(id, dest, claimedBy) {
  const file = join(ticketDir(), id + '.md');
  let raw = readFileSync(file, 'utf8');
  raw = raw.replace(/^claimed_by:.*$/m, 'claimed_by: ' + claimedBy);
  raw = raw.replace(/^claimed_at:.*$/m, 'claimed_at: ' + new Date().toISOString());
  raw = raw.replace(/^(-\s*worktree:).*$/m, '$1 ' + dest);
  raw = raw.replace(/^(-\s*status:)\s*\S+/m, '$1 in-progress');
  writeFileSync(file, raw, 'utf8');
}

function cmdNew(branch, base, ticketIds = []) {
  if (!branch) die('usage: node tools/worktree.mjs new <branch> [--from <base>] [--ticket T-###]...');
  const dest = pathFor(branch);
  if (existsSync(dest)) {
    die('a worktree already exists at ' + dest +
        '\n    One branch has one driver — pick different work, or run "done ' + branch + '" first.');
  }

  // Ticket ids are checked before anything else touches disk or git — a bad
  // id must refuse and leave no directory behind.
  verifyTickets(ticketIds);

  base = base || defaultBase();
  mkdirSync(treeRoot, { recursive: true });

  try {
    git(['fetch', '--quiet', 'origin', base]);
  } catch {
    // offline, or no remote for this base — branching from the local ref is fine
  }

  console.log('\n  worktree  ' + branch);
  console.log('  path      ' + dest);
  console.log('  base      ' + base + (branchExists(branch) ? ' (branch exists — checking it out)' : ''));
  console.log('');

  const args = branchExists(branch)
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', dest, '-b', branch, base];
  run('git', args, repoRoot);

  for (const f of CARRY) {
    const src = join(repoRoot, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dest, f));
      console.log('  carried   ' + f);
    } else {
      console.log('  ! missing ' + f + ' in the main checkout — this tree will not boot until you add one.');
    }
  }

  console.log('\n  installing dependencies...\n');
  try {
    run('npm', ['ci', '--no-audit', '--no-fund'], dest);
  } catch (e) {
    console.error('\n  ! npm ci failed: ' + (e.code || e.message));
  }

  // Check the install rather than assume it. The first version of this script
  // reported success while npm had actually crashed, because nothing looked at
  // the result — and a tree with no node_modules fails much later, somewhere
  // that has nothing to do with the real cause.
  if (!existsSync(join(dest, 'node_modules'))) {
    die('the worktree exists at ' + dest + ' but dependencies are NOT installed.\n' +
        '    Run "npm ci" in that directory before using it.');
  }

  console.log('\n  ok. cd ' + dest + '\n');
  console.log('    Before editing, confirm the branch:  git rev-parse --abbrev-ref HEAD\n');
  // The board is shared and lives outside every tree. Say so here, because a
  // fresh worktree is exactly where an agent is most likely to go looking for
  // a local copy of it and find only the signpost.
  console.log('    The task board is shared, and is NOT in this tree:');
  console.log('      node tools/board.mjs show\n');

  if (ticketIds.length) {
    const by = claimant(branch);
    for (const id of ticketIds) {
      try {
        stampTicket(id, dest, by);
        console.log('  ok  ' + id + ' stamped: in-progress, worktree ' + dest + ', claimed by ' + by);
      } catch (e) {
        // The tree exists whether or not this write succeeds. Say so plainly
        // rather than leaving the caller to assume the claim went through.
        console.error('\n  !! BOARD WRITE FAILED for ' + id + ': ' + (e.message || e));
        console.error('  !! The worktree at ' + dest + ' WAS created. The board was NOT updated.');
        console.error('  !! Stamp ' + id + ' by hand: status in-progress, worktree, claimed_by, claimed_at.\n');
        process.exitCode = 1;
      }
    }
  } else {
    // This is the exact gap T-230 exists to close: an unstamped tree looks,
    // from the board, like work that never started. Make that loud, not a
    // footnote at the bottom of a long log.
    console.log('  ################################################################');
    console.log('  ##  NO --ticket GIVEN.                                       ##');
    console.log('  ##  The board will NOT know about this tree or this work.    ##');
    console.log('  ##  Re-run with --ticket T-### to claim it, or update the    ##');
    console.log('  ##  ticket by hand.                                          ##');
    console.log('  ################################################################\n');
  }
}

function cmdList() {
  const blocks = git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/).filter(Boolean);
  console.log('');
  for (const block of blocks) {
    const o = {};
    for (const line of block.split(/\r?\n/)) {
      const [k, ...rest] = line.split(' ');
      o[k] = rest.join(' ');
    }
    const p = o.worktree;
    const b = (o.branch || '(detached)').replace('refs/heads/', '');
    let state = '?';
    try {
      const st = git(['status', '--porcelain'], { cwd: p });
      state = st ? st.split(/\r?\n/).length + ' uncommitted' : 'clean';
    } catch {
      state = 'not a git worktree';
    }
    console.log('  ' + b.padEnd(34) + state.padEnd(20) + p);
  }
  console.log('');
}

function cmdDone(branch, deleteBranch) {
  if (!branch) die('usage: node tools/worktree.mjs done <branch> [--delete-branch]');
  const dest = pathFor(branch);
  const registered = registeredWorktrees().includes(norm(dest));

  if (!existsSync(dest) && !registered) die('no worktree at ' + dest);

  if (existsSync(dest) && !registered) {
    // Orphan: directory still on disk, git no longer tracks it. This is what a
    // half-finished removal leaves behind on Windows.
    console.log('  ! ' + dest + ' is no longer a registered worktree — removing the leftover directory.');
    rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    git(['worktree', 'prune']);
    console.log('  ok  cleaned up');
  } else {
    const st = git(['status', '--porcelain'], { cwd: dest });
    if (st) {
      die(branch + ' has uncommitted changes — refusing to remove it.\n\n' + st +
          '\n    Commit or discard them in ' + dest + ' first.');
    }

    try {
      run('git', ['worktree', 'remove', dest], repoRoot);
    } catch {
      console.log('  ! git could not delete the files (Windows + node_modules) — removing them directly.');
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    git(['worktree', 'prune']);
    console.log('  ok  removed ' + dest);
  }

  if (deleteBranch) {
    try {
      git(['branch', '-d', branch]);       // -d, never -D: refuses if unmerged
      console.log('  ok  deleted branch ' + branch);
    } catch {
      console.log('  ! branch ' + branch + ' is not fully merged — left in place.');
    }
  }
}

const [, , cmd, arg, ...rest] = process.argv;
const flag = (n) => rest.includes(n);
const opt = (n) => {
  const i = rest.indexOf(n);
  return i === -1 ? null : rest[i + 1];
};
// --ticket may be given more than once; collect every value.
const optsAll = (n) => rest.reduce((acc, v, i) => (v === n ? [...acc, rest[i + 1]] : acc), []);

switch (cmd) {
  case 'new':
    cmdNew(arg, opt('--from'), optsAll('--ticket'));
    break;
  case 'list':
    cmdList();
    break;
  case 'done':
    cmdDone(arg, flag('--delete-branch'));
    break;
  default:
    console.log('\n  node tools/worktree.mjs new  <branch> [--from <base>] [--ticket T-###]...  create + provision a worktree' +
                '\n  node tools/worktree.mjs list                            show every worktree and its state' +
                '\n  node tools/worktree.mjs done <branch> [--delete-branch] remove a worktree (refuses if dirty)' +
                '\n\n  Worktrees live in ../' + SIBLING + '/<branch>. Base defaults to staging, else main.' +
                '\n  --ticket T-### verifies the ticket exists first, then stamps it in-progress' +
                '\n  with the worktree path and who/when claimed it. Without it, the tree is' +
                '\n  still created but the board will not know about it (loudly noted).\n');
    process.exit(cmd ? 1 : 0);
}
