// ════════════════════════════════════════════════════════════════════════════
// The producer tree — ids, codes, materialized paths, and the relation between
// two nodes. Pure functions over plain strings, with no AWS SDK anywhere in the
// file, so every rule below is provable under plain `node` before it reaches a
// Lambda.
//
// WHY THE PATH IS NOT AN OPTIMIZATION (AGENCY_BACKEND.md §2.2). Every
// visibility and rollup question in the hierarchy reduces to a string
// operation on this path:
//
//   whole subtree        path prefix match
//   is A above B?        B.path startsWith A.path
//   cross-stream         neither prefixes the other
//   lowest common anc.   longest common prefix
//
// So a stale path does not throw, does not look wrong, and silently corrupts
// both who-can-see-what and every branch total that rolls through it. That is
// the single largest correctness risk in the whole Agency build, which is why
// path construction lives in one file with tests around it rather than being
// concatenated at each call site.
// ════════════════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';

/** Separator and terminator. Every path both starts and ends with it. */
export const PATH_SEP = '/';

// ── Depth and length ceilings ───────────────────────────────────────────────
//
// `path` is a DynamoDB sort key on the byRootPath index, and a sort key is
// capped at 1024 BYTES. Exceeding it does not truncate — the write is rejected,
// which in the middle of a subtree re-parent would leave the tree half-rewritten
// and therefore silently wrong. Both ceilings below exist to make that failure
// impossible to reach, and to fail it up front with a message a person can act
// on instead of mid-loop.
//
// 17 bytes per level (a 16-char id plus its separator) puts 40 levels at 681
// bytes, comfortably inside the limit with room for the leading separator and
// for a longer id format later. Real agency hierarchies are nowhere near this
// deep — the largest one in production is wide, not deep — so a tree that hits 40 is far more likely to
// be a bug than a business.

/** Maximum number of nodes from a fragment root down to a leaf. */
export const MAX_DEPTH = 40;

/** Hard byte ceiling on a stored path, under DynamoDB's 1024-byte sort key. */
export const MAX_PATH_BYTES = 900;

// ── Node ids ────────────────────────────────────────────────────────────────
//
// Deliberately NOT randomUUID(). The id is a path segment, repeated at every
// level of every descendant's path, so its length is multiplied by the depth of
// the tree: a 36-char UUID costs 37 bytes per level and would put the ceiling
// at ~24 levels rather than 40, for no benefit. 16 characters of this alphabet
// is 80 bits of entropy, and every insert is a conditional write on
// attribute_not_exists(id), so a collision is both astronomically unlikely and
// caught rather than silently overwriting a node.

/** Crockford-style base32: no I, L, O or U — unambiguous when read aloud. */
export const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ID_LENGTH = 16;

type RandomBytes = (n: number) => Uint8Array;

/**
 * Draw `count` characters from `alphabet` without modulo bias.
 *
 * Rejection sampling rather than `byte % alphabet.length`: with a 32-character
 * alphabet the modulo happens to be uniform, but the code-generation alphabet
 * below has 31 characters and a naive modulo would make the first 8 characters
 * measurably more likely. Codes are typed by humans and compared by eye — a
 * skewed distribution would raise the collision rate for no visible reason.
 */
function pick(alphabet: string, count: number, rand: RandomBytes): string {
  const n = alphabet.length;
  const limit = 256 - (256 % n);   // largest multiple of n that fits in a byte
  let out = '';
  while (out.length < count) {
    const buf = rand(count * 2);
    for (let i = 0; i < buf.length && out.length < count; i++) {
      const b = buf[i];
      if (b < limit) out += alphabet[b % n];
    }
  }
  return out;
}

/** A fresh node id. Injectable randomness so the tests are deterministic. */
export function newNodeId(rand: RandomBytes = randomBytes): string {
  return pick(ID_ALPHABET, ID_LENGTH, rand);
}

/** Is this a well-formed node id? Used to reject a hand-crafted path segment. */
export function isNodeId(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== ID_LENGTH) return false;
  for (const ch of value) if (!ID_ALPHABET.includes(ch)) return false;
  return true;
}

// ── Producer codes ──────────────────────────────────────────────────────────
//
// The public handle for placement (AGENCY_HIERARCHY.md §5.1). Codes are PUBLIC,
// not secret — they appear in page headers, and approval is the only gate. A
// code addresses a request; it does not authorize one.
//
// Shape is `8H2K-QR` — four, hyphen, two. It must stay VISIBLY DIFFERENT from a
// seat code (`SEAT-4KQ2-B9`, PRICING.md §2): the two mean completely different
// things (one attaches you to an upline, one lets you log in) and typing one
// into the other's box has to fail obviously rather than resolve to something.
// The literal `SEAT-` prefix and the third group are what separate them at a
// glance, so neither is ever added here.

/** The id alphabet minus `1`, which is indistinguishable from `I` in most UIs. */
export const CODE_ALPHABET = '023456789ABCDEFGHJKMNPQRSTVWXYZ';

const CODE_HEAD = 4;
const CODE_TAIL = 2;

/** A fresh producer code, e.g. `8H2K-QR`. Uniqueness is the caller's job. */
export function newProducerCode(rand: RandomBytes = randomBytes): string {
  const raw = pick(CODE_ALPHABET, CODE_HEAD + CODE_TAIL, rand);
  return `${raw.slice(0, CODE_HEAD)}-${raw.slice(CODE_HEAD)}`;
}

/**
 * Canonical form of whatever the user typed.
 *
 * People read these off a phone screen and out of text messages, so the input
 * arrives lowercased, unhyphenated or space-separated. Folding that here is
 * what makes a correctly-read code resolve on the first try — without it the
 * failure is "no producer found", which reads as the other person not existing
 * rather than as a typo.
 *
 * `O` folds to `0` because the alphabet has no `O` and that substitution has
 * exactly one possible intent. `I`, `L`, `U` and `1` are NOT folded: none is in
 * the alphabet, and each could stand for more than one character, so guessing
 * would resolve to a real but different producer's node. Those are rejected
 * instead, which surfaces as "that code isn't valid" — the honest answer.
 *
 * Returns '' for anything that cannot be a code, so a caller can treat empty as
 * "do not even look it up".
 */
export function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const folded = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0');
  if (folded.length !== CODE_HEAD + CODE_TAIL) return '';
  for (const ch of folded) if (!CODE_ALPHABET.includes(ch)) return '';
  return `${folded.slice(0, CODE_HEAD)}-${folded.slice(CODE_HEAD)}`;
}

/** Is this already a canonical producer code? */
export function isProducerCode(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && normalizeCode(value) === value;
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** The path of a fragment root: `/<id>/`. */
export function rootPath(nodeId: string): string {
  return PATH_SEP + nodeId + PATH_SEP;
}

/** The path of a child of `parentPath`. */
export function childPath(parentPath: string, nodeId: string): string {
  return parentPath + nodeId + PATH_SEP;
}

/** Every id on a path, root first. `''` and malformed input give `[]`. */
export function segmentsOf(path: unknown): string[] {
  if (typeof path !== 'string' || !path.startsWith(PATH_SEP)) return [];
  return path.split(PATH_SEP).filter(Boolean);
}

/** How many nodes are on this path, root included. */
export function pathDepth(path: unknown): number {
  return segmentsOf(path).length;
}

/**
 * The fragment root this path hangs off.
 *
 * This is the byRootPath index's PARTITION key, and it is derived from the path
 * rather than tracked separately on purpose: two fields that must agree are two
 * fields that can disagree. Deriving it means a re-parent that rewrites the
 * path cannot forget to rewrite the root.
 */
export function rootIdOf(path: unknown): string {
  return segmentsOf(path)[0] || '';
}

/** The node this path ends at. */
export function leafIdOf(path: unknown): string {
  const segs = segmentsOf(path);
  return segs[segs.length - 1] || '';
}

/** The parent's path, or '' if this is a fragment root. */
export function parentPathOf(path: unknown): string {
  const segs = segmentsOf(path);
  if (segs.length < 2) return '';
  return PATH_SEP + segs.slice(0, -1).join(PATH_SEP) + PATH_SEP;
}

/**
 * Is `a` strictly above `b`?
 *
 * The trailing separator on every path is what makes this a plain
 * `startsWith`: without it `/abc/` would prefix `/abcd/` and two unrelated
 * fragments would read as parent and child. Never store a path without it.
 */
export function isAncestorPath(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return b !== a && b.startsWith(a);
}

/**
 * Where the subject sits relative to the viewer.
 *
 * Mirrors relOf() in src/js/pages/agency.js. AGENCY_HIERARCHY.md §6 opens every
 * producer's PAGE to every producer, so this does not gate reading — it gates
 * ACTIONS, and the only value that grants any is 'down'. Ability travels
 * downward only, never up and never sideways (AGENCY_BACKEND.md §5).
 */
export type Relation = 'self' | 'down' | 'up' | 'cross';

export function relationOf(viewerPath: string, subjectPath: string): Relation {
  if (!viewerPath || !subjectPath) return 'cross';
  if (viewerPath === subjectPath) return 'self';
  if (isAncestorPath(viewerPath, subjectPath)) return 'down';
  if (isAncestorPath(subjectPath, viewerPath)) return 'up';
  return 'cross';
}

/** Longest common ancestor path of two nodes, or '' if they share no root. */
export function commonAncestorPath(a: string, b: string): string {
  const as = segmentsOf(a);
  const bs = segmentsOf(b);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) break;
    shared.push(as[i]);
  }
  if (!shared.length) return '';
  return PATH_SEP + shared.join(PATH_SEP) + PATH_SEP;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Reject a path that cannot be stored, BEFORE anything is written.
 *
 * A re-parent rewrites a whole subtree. Discovering at node 300 of 400 that the
 * key is too long leaves half the subtree on the new path and half on the old —
 * a corruption with no error message and no way to tell by looking. So every
 * candidate path is checked first and the whole operation is refused as a unit.
 */
export function assertPathStorable(path: string): void {
  const depth = pathDepth(path);
  if (depth === 0) throw new Error('Path is empty or malformed.');
  if (depth > MAX_DEPTH) {
    throw new Error(
      `This would put a producer ${depth} levels deep; the limit is ${MAX_DEPTH}. ` +
      'Nothing was changed.'
    );
  }
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    throw new Error(
      `The resulting hierarchy path is ${bytes} bytes, over the ${MAX_PATH_BYTES}-byte ` +
      'limit. Nothing was changed.'
    );
  }
}

// ── Re-parenting ────────────────────────────────────────────────────────────

export interface PathBearing {
  id: string;
  path: string;
}

export interface PathRewrite {
  id: string;
  path: string;
  rootNodeId: string;
}

/**
 * The new path for every node in a subtree being re-parented.
 *
 * A subtree keeps its internal shape exactly — only the prefix above it
 * changes — so this is one string splice per node rather than a tree walk. The
 * whole result is computed and validated before the caller writes anything, so
 * a rejection costs nothing and a half-applied move cannot happen.
 *
 * Cycle rejection lives here rather than in the caller because it is the same
 * string comparison: moving a node underneath its own descendant makes the new
 * prefix start with the old one, and the tree would close a loop that every
 * prefix query then walks forever.
 */
export function reparentedPaths(
  subtree: PathBearing[],
  oldPrefix: string,
  newParentPath: string,
): PathRewrite[] {
  const subjectId = leafIdOf(oldPrefix);
  if (!subjectId) throw new Error('Cannot re-parent: the subject has no valid path.');

  const newPrefix = newParentPath ? childPath(newParentPath, subjectId) : rootPath(subjectId);

  if (newPrefix === oldPrefix) {
    throw new Error('That is already their upline; nothing to move.');
  }
  // The move-onto-own-descendant case. `newParentPath` sits inside the subtree
  // being moved, so attaching there would make the subtree its own ancestor.
  if (newParentPath && (newParentPath === oldPrefix || newParentPath.startsWith(oldPrefix))) {
    throw new Error('A producer cannot be moved underneath their own downline.');
  }

  const out: PathRewrite[] = [];
  for (const node of subtree) {
    if (node.path !== oldPrefix && !node.path.startsWith(oldPrefix)) {
      throw new Error(`Node ${node.id} is not inside the subtree being moved.`);
    }
    const path = newPrefix + node.path.slice(oldPrefix.length);
    assertPathStorable(path);
    out.push({ id: node.id, path, rootNodeId: rootIdOf(path) });
  }
  return out;
}

/**
 * Rebuild every path in a fragment from its parent edges, roots first.
 *
 * This is the INVARIANT CHECK the build plan asks for ("assert every node's
 * path equals the concatenation of its ancestor chain"), expressed as a
 * recomputation: compare what is stored against what this returns and any
 * drift shows up as a difference rather than having to be reasoned about.
 *
 * Nodes whose parent is missing from the input are treated as fragment roots,
 * which is the correct reading — an unattached producer IS a root
 * (AGENCY_HIERARCHY.md §4.2) and so is one whose parent was not loaded.
 */
export interface ParentEdge {
  id: string;
  parentNodeId?: string | null;
}

export function recomputePaths(nodes: ParentEdge[]): Map<string, string> {
  const byId = new Map<string, ParentEdge>();
  for (const n of nodes) byId.set(n.id, n);

  const paths = new Map<string, string>();

  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached) return cached;
    if (seen.has(id)) {
      throw new Error(`Cycle in the producer tree at node ${id}.`);
    }
    seen.add(id);

    const node = byId.get(id);
    const parentId = node?.parentNodeId;
    const path = parentId && byId.has(parentId)
      ? childPath(resolve(parentId, seen), id)
      : rootPath(id);

    paths.set(id, path);
    return path;
  };

  for (const n of nodes) resolve(n.id, new Set());
  return paths;
}
