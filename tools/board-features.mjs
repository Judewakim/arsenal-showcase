#!/usr/bin/env node
/**
 * board-features.mjs — the ONE shared classifier for feature-level grouping
 * (T-271). The owner thinks in FEATURES ("dial tracker", "billing"); every
 * view the board has ever offered is at ticket granularity. This module is
 * the single place that fact gets computed, so `board.mjs features`,
 * `board-dashboard.mjs` and `board-sweep.mjs` can all import it instead of
 * each hand-deriving its own copy of "what status is this feature at" — the
 * exact way three copies of one fact broke this repo's tools before.
 *
 * Same shape as board-queue.mjs on purpose: this file takes plain ticket
 * data in (already run through `parseTicket`) and returns plain data out.
 * It does not read the board, does not shell to git, and does not import
 * board.mjs or board-sweep.mjs — so it cannot become part of a cycle with
 * either, and neither of them needs to import the other to reach it.
 *
 * ── Reopened 2026-09-26 (coordinator amendment on T-271) ────────────────────
 *
 * Three corrections, all classifier logic, all in this file:
 *
 * (1) Branch is not feature. Tickets get their `- feature:` value from
 *     whoever files them, and in practice that has been the branch name —
 *     so one real feature ends up as ten "features" that are really one.
 *     FEATURE_ALIASES below is the single place that gets folded back.
 *
 * (2) The old rule was "any blocked ticket -> blocked", lowest-first. That
 *     let ONE blocked ticket hide FOURTEEN tickets sitting on staging
 *     waiting on the human — exactly the failure this module exists to
 *     prevent. The new rule: a feature's status is the FURTHEST-ALONG
 *     state a STRICT MAJORITY of its tickets share (>50% — only one state
 *     can ever qualify, since the states partition the tickets). When no
 *     state reaches a majority, fall back to the plurality, ties broken
 *     furthest-along. This SUPERSEDES the "lowest-first" rule from the
 *     original acceptance criteria — a tester checking against the
 *     original wording is checking a retired rule.
 *     The single blocked ticket never disappears, though — it still shows
 *     up in `statusLineFor` and in `nextActionFor`'s joined YOU: line,
 *     it just no longer overrides a feature that is mostly testable.
 *
 * (3) `dev-team` is a 35-ticket catch-all, not a feature the human is
 *     actively driving. `reachesQueue` keeps it out of the human's queue
 *     (the SessionStart pin, `board.mjs mine`) unless one of its tickets
 *     is actually human-review, staging, or blocked — i.e. unless there
 *     is something in it only the human can move. Its line in `features`
 *     is untouched; this only gates the queue views, and it lives here so
 *     board.mjs and board-sweep.mjs read one fact instead of two.
 */

// ── (1) Branch is not feature ────────────────────────────────────────────
//
// Maps a ticket's raw `- feature:` value (often a branch name) to the
// canonical feature slug it actually belongs to. Applied by `featureOf`
// before anything else sees the value, so every other function in this
// module and every caller only ever sees the canonical slug.
//
// To add a feature: pick (or reuse) ONE canonical slug on the right, then
// add one `'raw-value': 'canonical-slug',` line per raw `- feature:` value
// that belongs under it. Extend this table — never fork it, and never
// special-case a raw value anywhere else in this file or its callers.
const FEATURE_ALIASES = {
  'sms-fire': 'sms-backend',
  'sms-fire-atomic-claim': 'sms-backend',
  'sms-fire-sandbox-env': 'sms-backend',
  'sms-lifecycle-index-grants': 'sms-backend',
  'unmatched-inbound': 'sms-backend',
  'scheduler-role-source-condition': 'sms-backend',
  'provisioning-entitlement': 'sms-backend',
  'server-side-entitlement': 'sms-backend',
  'seat-code-throttle': 'sms-backend',
  'webhook-approved-anchor': 'sms-backend',

  'taxonomy-core': 'taxonomy',
  'taxonomy-rename': 'taxonomy',
  'taxonomy-backend': 'taxonomy',
  'product-age-filter': 'taxonomy',

  'orphan-imports-vacuous': 'dev-team',
  'pre-push-remote-ref': 'dev-team',
  'promote-by-sha': 'dev-team',
  'crm-dnc-check': 'dev-team',
};

// A parsed ticket (from board-queue.mjs's `parseTicket`) -> its canonical
// feature slug, or "" when the `- feature:` line is absent. Free text past
// the alias table, not otherwise validated — grouping is by exact string
// match, same as `parseTicket` treats any other field.
export function featureOf(parsedTicket) {
  const raw = (parsedTicket && parsedTicket.feature) || '';
  if (!raw) return '';
  return FEATURE_ALIASES[raw] || raw;
}

// ── Per-ticket status -> canonical group ─────────────────────────────────
//
// One ticket's raw board status -> the six-word vocabulary the human reads.
// An unrecognized status (typo, the retired "review") has no rank we can
// trust and is treated as `blocked` so it drags its feature down instead of
// silently vanishing from every count.
const KNOWN_STATUSES = new Set([
  'blocked', 'todo', 'in-progress', 'tester-review', 'human-review',
  'staging', 'shipped', 'done',
]);

function categoryOf(status) {
  if (status === 'todo' || status === 'in-progress') return 'in progress';
  if (status === 'tester-review') return 'in testing';
  if (status === 'human-review') return 'awaiting your approval';
  if (status === 'staging') return 'on staging';
  if (status === 'shipped' || status === 'done') return 'shipped';
  if (status === 'blocked') return 'blocked';
  return 'blocked'; // unknown/typo'd status -- lowest rung, never dropped
}

// Furthest-along first. Used both to find the majority/plurality group and
// to order the segments in `statusLineFor`'s display line.
const GROUPS_FURTHEST_FIRST = [
  'shipped', 'on staging', 'awaiting your approval', 'in testing',
  'in progress', 'blocked',
];

// ── (2) deriveFeatureStatus — majority rule, furthest-along tie-break ───
//
// statuses: raw status strings (as `parseTicket` produces them) for every
// ticket in one feature. Returns the FURTHEST-ALONG canonical group that a
// STRICT MAJORITY (>50%) of the tickets share. Because the six groups
// partition the tickets, at most one group can ever hold a strict
// majority, so there is no ambiguity to break in that case. When no group
// reaches a majority (a genuinely fragmented feature), falls back to the
// plurality group, ties broken furthest-along.
//
// An empty list has no defined status; callers never call this on one.
export function deriveFeatureStatus(statuses) {
  if (!statuses || statuses.length === 0) return 'in progress';

  const counts = new Map();
  for (const s of statuses) {
    const g = categoryOf(s);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const total = statuses.length;

  for (const g of GROUPS_FURTHEST_FIRST) {
    if ((counts.get(g) || 0) > total / 2) return g;
  }

  let best = GROUPS_FURTHEST_FIRST[0];
  let bestCount = -1;
  for (const g of GROUPS_FURTHEST_FIRST) {
    const c = counts.get(g) || 0;
    if (c > bestCount) { bestCount = c; best = g; }
  }
  return best;
}

// Groups a feature's tickets by canonical status, furthest-along first,
// dropping empty groups. Shared by `statusLineFor` and `nextActionFor` so
// the display line and the action line can never disagree about who is in
// which bucket.
function segmentsFor(tickets) {
  const byGroup = new Map();
  for (const t of tickets) {
    const g = categoryOf(t.status);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(t);
  }
  const segments = [];
  for (const g of GROUPS_FURTHEST_FIRST) {
    const ts = byGroup.get(g);
    if (ts && ts.length) segments.push({ group: g, tickets: ts });
  }
  return segments;
}

// `- depends-on:` on this board is often PROSE ("feat/sms-backend merged to
// staging"), not a ticket id. Splicing that verbatim into a display line or
// a YOU: instruction produces "unblock feat/sms-backend merged to staging",
// which is not an action. Pull out ONLY things that look like ticket ids
// (T-\d+) and discard everything else. Returns [] when nothing matches.
function idsFromDependsOn(text) {
  const m = (text || '').match(/T-\d+/g);
  return m ? [...new Set(m)] : [];
}

// A blocked ticket's display target: the ticket id(s) it is blocked ON, when
// `- depends-on:` names any; otherwise the BLOCKED ticket itself, so the
// reader always gets a ticket id and never a sentence.
function blockedTargets(ticket) {
  const ids = idsFromDependsOn(ticket.dependsOn);
  return ids.length ? ids : [ticket.id];
}

// Truncates a list for display: "a, b, c" up to `max` items, then
// "a, b, +N more" so one ticket with a dozen dependency ids cannot blow out
// a line meant to be scanned in one glance.
function truncateList(items, max = 3) {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, +${items.length - max} more`;
}

// Hard cap on a rendered line's length, so one pathological ticket (a
// `depends-on` that is a full sentence, a feature with a dozen segments)
// cannot wreck column alignment for every other row. Scannability is the
// deliverable here, not completeness — the ticket itself has the full detail.
const MAX_LINE_CHARS = 100;
function capLine(s) {
  return s.length <= MAX_LINE_CHARS ? s : `${s.slice(0, MAX_LINE_CHARS - 1)}…`;
}

// Segments actually worth printing in a QUEUE view: the majority/plurality
// group (the feature's overall status) plus anything the human is OWED --
// on staging, awaiting approval, blocked. `shipped`/`in testing`/
// `in progress` are noise once a feature also has owed work; they stay
// visible only when one of them IS the majority (nothing else to show).
const OWED_GROUPS = new Set(['on staging', 'awaiting your approval', 'blocked']);
function visibleSegments(tickets) {
  const majority = deriveFeatureStatus(tickets.map(t => t.status));
  return segmentsFor(tickets).filter(seg => seg.group === majority || OWED_GROUPS.has(seg.group));
}

// A feature (with `.tickets`) -> the human-readable multi-segment status
// line, e.g. "on staging (14) · blocked (1: T-138 on T-168)". A blocked
// segment names each blocked ticket and, when known (`- depends-on:` names
// an actual ticket id), what it is blocked ON — so "one blocked ticket"
// never reads as an opaque count, and prose in `depends-on` is discarded
// rather than spliced in verbatim. Only the majority segment plus anything
// owed to the human is shown (see `visibleSegments`), and the whole line is
// capped so columns stay aligned. Falls back to the bare `.status` word when
// there are no tickets to break down (e.g. a hand-built feature object in a
// test).
export function statusLineFor(feature) {
  const tickets = feature && feature.tickets;
  if (!tickets || tickets.length === 0) return (feature && feature.status) || '';
  const line = visibleSegments(tickets).map(seg => {
    if (seg.group === 'blocked') {
      const detail = truncateList(seg.tickets.map(t => {
        const targets = blockedTargets(t);
        return targets.length === 1 && targets[0] === t.id ? t.id : `${t.id} on ${targets.join('/')}`;
      }));
      return `blocked (${seg.tickets.length}: ${detail})`;
    }
    return `${seg.group} (${seg.tickets.length})`;
  }).join(' · ');
  return capLine(line);
}

function simpleActionFor(status) {
  switch (status) {
    case 'blocked': return 'unblock it — no agent can clear this';
    case 'awaiting your approval': return 'review and approve';
    case 'on staging': return 'say whether it works on staging';
    default: return '--';
  }
}

function actionForSegment(seg) {
  switch (seg.group) {
    case 'on staging': return 'test on staging';
    case 'awaiting your approval': return 'review and approve';
    case 'blocked': {
      const targets = [...new Set(seg.tickets.flatMap(blockedTargets))];
      return targets.length ? `unblock ${truncateList(targets)}` : 'unblock it — no agent can clear this';
    }
    default: return null; // in progress / in testing / shipped -- nothing owed
  }
}

// ── mine-only: a header that describes EXACTLY the subset it lists ──────────
//
// T-273 (reopened): `statusLineFor`/`nextActionFor` above are computed over
// a feature's WHOLE ticket set (majority segment + owed segments), because
// that is correct for `features` — it lists the whole feature. `mine`
// prints a FILTERED subset beneath its header (only what `buildMineQueue`
// actually returned for that slug, after `reachesQueue` gating), so a
// header built from the whole feature can name a count that does not match
// what is printed below it. These two functions take ONLY the subset
// actually being printed and describe THAT — no majority segment, because a
// subset that reached the queue is, by construction, entirely blocked /
// on-staging / awaiting-your-approval already. Never call these on a
// feature's full ticket list; that is what `statusLineFor`/`nextActionFor`
// are for.
export function statusLineForSubset(tickets) {
  if (!tickets || tickets.length === 0) return '';
  const line = segmentsFor(tickets).map(seg => {
    if (seg.group === 'blocked') {
      const detail = truncateList(seg.tickets.map(t => {
        const targets = blockedTargets(t);
        return targets.length === 1 && targets[0] === t.id ? t.id : `${t.id} on ${targets.join('/')}`;
      }));
      return `blocked (${seg.tickets.length}: ${detail})`;
    }
    return `${seg.group} (${seg.tickets.length})`;
  }).join(' · ');
  return capLine(line);
}

export function nextActionForSubset(tickets) {
  if (!tickets || tickets.length === 0) return '--';
  const actions = segmentsFor(tickets).map(actionForSegment).filter(Boolean);
  return actions.length ? capLine(actions.join('; ')) : '--';
}

// One feature's derived status -> the ONE line naming EVERY distinct thing
// the human is owed, e.g. "test on staging; unblock T-168". Always
// derived, never stored. Only draws from `visibleSegments` (majority +
// owed), same set `statusLineFor` shows, and the joined line is capped so
// it cannot wreck column alignment. When `feature.tickets` is absent (a
// hand-built `{ status }` object, as the original single-status tests
// use), falls back to the single-status line so the plain-status API
// keeps working.
export function nextActionFor(feature) {
  if (!feature) return '--';
  const tickets = feature.tickets;
  if (!tickets || tickets.length === 0) return simpleActionFor(feature.status);

  const actions = visibleSegments(tickets)
    .map(actionForSegment)
    .filter(Boolean);
  return actions.length ? capLine(actions.join('; ')) : '--';
}

// ── (3) dev-team must not reach the human's queue by default ────────────
//
// `dev-team` is a 35-ticket catch-all, not a feature the human is actively
// driving. It only belongs in the human's queue (the SessionStart pin,
// `board.mjs mine`) when one of its tickets needs the human specifically:
// human-review, staging, or blocked (this board treats every `blocked` as
// blocked-on-the-owner — see board-queue.mjs's classifyMine). Every other
// feature always reaches the queue; this gate is dev-team-specific by
// design, not a general "big features get hidden" rule.
export function reachesQueue(feature) {
  if (!feature) return false;
  if (feature.slug !== 'dev-team') return true;
  const tickets = feature.tickets || [];
  return tickets.some(t => t.status === 'human-review' || t.status === 'staging' || t.status === 'blocked');
}

// parsedTickets: array of tickets already run through board-queue.mjs's
// `parseTicket`. Returns features sorted deterministically (by canonical
// slug, locale-independent), each ticket without a `feature` excluded
// entirely — this module only groups what was tagged.
export function groupByFeature(parsedTickets) {
  const bySlug = new Map();
  for (const t of parsedTickets || []) {
    const slug = featureOf(t);
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(t);
  }

  const features = [];
  for (const slug of [...bySlug.keys()].sort()) {
    const tickets = bySlug.get(slug);
    const status = deriveFeatureStatus(tickets.map(t => t.status));
    const feature = { slug, status, count: tickets.length, tickets };
    feature.statusLine = statusLineFor(feature);
    feature.nextAction = nextActionFor(feature);
    feature.reachesQueue = reachesQueue(feature);
    features.push(feature);
  }
  return features;
}
