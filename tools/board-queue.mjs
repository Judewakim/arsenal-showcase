#!/usr/bin/env node
/**
 * board-queue.mjs — the human's own queue: WAITING ON YOU + NEEDS A PERSON.
 *
 * Shared by `board-sweep.mjs` (the full stall sweep, all ten categories) and
 * `board.mjs`'s `mine` command (the human's slice alone, plus the `status`
 * pin), so the two can never drift apart the way a hand-kept second copy
 * always eventually does. One classifier; both callers read only through it.
 *
 * ── Why this file, not a function added to board.mjs or board-sweep.mjs ─────
 *
 * board-sweep.mjs already does `import { readTickets, ticketIdsIn } from
 * './board.mjs'`. If the classifier lived in board.mjs and board-sweep.mjs
 * called back into it, that would still be fine (board-sweep already depends
 * on board.mjs) — but board.mjs's own `mine` command ALSO needs the
 * classifier, and board.mjs cannot import board-sweep.mjs (that back-edge
 * would be the cycle: board.mjs -> board-sweep.mjs -> board.mjs). Putting the
 * classifier in a third module that imports NEITHER of them breaks that
 * possibility structurally rather than by discipline: this file takes plain
 * ticket data in and returns plain classification data out. It does not read
 * the board, does not shell to git, and does not know either caller exists.
 *
 * ── What "reuse the sweep's why/action wording" means in practice ───────────
 *
 * `classifyMine()` below is the sweep's own WAITING ON YOU / NEEDS A PERSON
 * branches, moved here verbatim in meaning. board-sweep.mjs calls this
 * instead of re-deriving the same two sentences, so the two surfaces cannot
 * say different things about the same ticket.
 */
import { statSync } from 'node:fs';

// A ticket's `- branch:` field is prose as often as it is a ref: "staging
// (committed 7ba3f47, not pushed)", "fix/x (merged, branch deleted)". Take
// the first token and drop it if it looks like prose, not a ref. (No git
// verification here on purpose — see classifyMine below for why none is
// needed.)
export function firstBranchToken(branch) {
  const first = (branch || '').trim().split(/[\s,(]/)[0];
  if (!first || first.startsWith('(')) return '';
  return first;
}

// A raw ticket ({ id, body, file, raw }) from board.mjs's readTickets() ->
// the flat fields every classifier and the dashboard read. Copied out of
// board-sweep.mjs's own inline mapper so both use the identical parse.
export function parseTicket(t) {
  const out = { id: t.id, title: '', status: 'unknown', branch: '', owner: '', feature: '', dependsOn: '' };
  for (const l of t.body.split(/\r?\n/)) {
    const h = l.match(/^### T-\d+\s*\|\s*(.+?)\s*$/);
    if (h) { out.title = h[1]; continue; }
    const f = l.match(/^-\s*([a-z-]+):\s*(.*)$/i);
    if (!f) continue;
    const k = f[1].toLowerCase(), v = f[2].trim();
    if (k === 'status' && out.status === 'unknown') out.status = v.split(/\s/)[0];
    else if (k === 'branch' && !out.branch) out.branch = v;
    else if (k === 'owner' && !out.owner) out.owner = v;
    else if (k === 'feature' && !out.feature) out.feature = v;
    else if (k === 'depends-on' && !out.dependsOn) out.dependsOn = v;
  }
  return out;
}

// One parsed ticket -> a { kind, why, action } finding, or null when it is
// not the human's own queue. `claimsOn(branch) -> Set<ticketId>` is the git
// lookup (board.mjs's `ticketIdsIn`), injected rather than imported so this
// module never shells to git itself and never imports board.mjs.
//
// No git-existence check on the branch before calling claimsOn: an invalid
// or prose-y branch token makes `git log <token>` fail, and the injected
// lookup already returns an empty set on any git failure (see board.mjs's
// `gitOut`). An unverified bad token and a verified-absent one both end up
// with an empty claims set, so skipping the verification changes nothing
// observable and keeps this module git-free.
export function classifyMine(t, { claimsOn } = {}) {
  if (t.status === 'blocked') {
    return {
      kind: 'NEEDS A PERSON',
      why: 'blocked — no agent can clear this',
      action: 'the owner has to act',
    };
  }
  if (t.status === 'human-review' || t.status === 'staging') {
    const br = firstBranchToken(t.branch);
    const committed = t.status === 'human-review' && br && claimsOn && claimsOn(br).has(t.id);
    return {
      kind: 'WAITING ON YOU',
      why: t.status === 'staging'
        ? 'deployed to staging — nobody has said whether it works'
        : committed
          ? `a tester passed it and it is committed on ${br} — it needs a merge`
          : 'a tester passed it, but the work is still uncommitted',
      action: 'yours to act on — no agent can move this one',
    };
  }
  return null;
}

// How long a ticket has sat where it is, honestly. There is no field that
// records "entered this status at T" — only `updated` (rewritten on ANY
// edit to the ticket, not just a status change) and, failing that, the
// file's own mtime. Both are labelled for what they are, never promoted to
// "in this status since". `t` is the raw ticket object from readTickets()
// (carries `.raw`, the whole file text including frontmatter, and `.file`,
// its path — or null for a ticket that exists only in the retired flat
// board.md, which is exactly when neither is available).
export function waitingSince(t) {
  if (t && t.raw) {
    const m = t.raw.match(/^updated:\s*(.+)$/m);
    if (m) {
      const d = new Date(m[1].trim());
      if (!Number.isNaN(d.getTime())) return { date: d, label: 'last board write' };
    }
  }
  if (t && t.file) {
    try {
      const st = statSync(t.file);
      return { date: st.mtime, label: 'file mtime' };
    } catch {
      // fall through to unknown
    }
  }
  return { date: null, label: 'unknown' };
}

export function formatAge(date, nowMs = Date.now()) {
  if (!date || Number.isNaN(date.getTime())) return 'unknown';
  const ms = Math.max(0, nowMs - date.getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// rawTickets: the array from readTickets().tickets (each { id, body, file,
// raw }). claimsOn: the git-backed lookup, injected — pass `() => new
// Set()` to skip the git call entirely (still correct, just less detail in
// the "committed on <branch>" wording for human-review).
//
// Sorted longest-waiting first; a ticket whose age is unknown sorts after
// every ticket with a known age (never invent a position for a number we
// don't have), then by id for a stable order.
export function buildMineQueue(rawTickets, { claimsOn, now = Date.now() } = {}) {
  const items = [];
  for (const rt of rawTickets) {
    const t = parseTicket(rt);
    const found = classifyMine(t, { claimsOn });
    if (!found) continue;
    const w = waitingSince(rt);
    items.push({
      id: t.id,
      title: t.title,
      branch: t.branch,
      status: t.status,
      kind: found.kind,
      why: found.why,
      action: found.action,
      waitingDate: w.date,
      waitingLabel: w.label,
      ageMs: w.date ? Math.max(0, now - w.date.getTime()) : null,
    });
  }
  items.sort((a, b) => {
    if (a.ageMs == null && b.ageMs == null) return a.id.localeCompare(b.id, undefined, { numeric: true });
    if (a.ageMs == null) return 1;
    if (b.ageMs == null) return -1;
    return b.ageMs - a.ageMs;
  });
  return items;
}
