// ════════════════════════════════════════════════════════════════════════════
// The audit hash chain — append atomically, verify honestly.
//
// WHY THIS EXISTS (A-09, SECURITY.md §6a). Every record change appends an
// AuditLog row carrying the hash of the previous row, so the log is a chain
// and a deleted row shows as a gap. For three months the append was two
// steps — read the latest hash, then write — with nothing between them. The
// live-call form autosaves every 600 ms, so two writes routinely read the same
// head and both chained off it: 225 forks on one owner's log by September,
// accelerating with usage, zero of them tampering. The chain's whole value is
// that a break MEANS something; at 225 benign breaks a malicious one is noise.
//
// THE FIX. One chain-head item per owner, in its own table, holding the hash
// and sequence number of the newest entry. Appending is a single
// TransactWriteItems: put the entry AND replace the head, conditioned on the
// head still holding the hash that was read. Two racing writers cannot both
// win; the loser re-reads the head and retries. The head table is separate so
// it never appears in the owner's audit viewer and never pollutes the
// AuditLog scan.
//
// THE PAST. Existing chains are forked and cannot be honestly repaired — a
// fork is two rows both claiming the same parent, and choosing one rewrites
// history. So the first atomic append for an owner reads the legacy latest
// hash once (the same rule the old code used), chains onto it, and from that
// row forward the chain is guaranteed. `walkChain` reports breaks BEFORE that
// cut-over as history (`legacyBreakCount`) and breaks AFTER it as the real
// thing (`brokenAtId`). Rows written atomically carry `seq` and `chainV: 2`;
// legacy rows carry neither. That is the genesis marker: not a row, a property.
//
// THE VERIFIER. The old one returned at the first break and reported 1, which
// is how 225 stayed hidden. This one walks the whole chain and counts.
//
// Every handler that appends to the AuditLog goes through here — secure-record,
// team-record and agency-node — so there is one chain algorithm, not three
// copies drifting (they had already drifted in the owner key they used).
//
// Pure where it can be (`hashEntry`, `sortEntries`, `walkChain`) so the logic
// is provable under plain node; the two DynamoDB functions take the client
// as a parameter so a test can hand in an in-memory one.
// ════════════════════════════════════════════════════════════════════════════

import { createHash, randomUUID } from 'node:crypto';
import {
  GetCommand, ScanCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export const GENESIS_PREV_HASH = 'GENESIS';

/** Rows written through `appendChained` carry this. Legacy rows carry nothing. */
export const CHAIN_VERSION = 2;

/** How many times a lost race — a stale condition OR a live transaction lock
 *  on the head item — is retried before giving up. Each retry re-reads the
 *  head, so this is the number of writers that can land ahead of us in a row
 *  before we surface an error. Both failure modes come from the same event
 *  (two writers hitting one owner's head at once); the burst size the system
 *  was sized for — autosave pairs and triples — has not changed just because
 *  DynamoDB now reports the two contention shapes under different codes. Six
 *  stays generous for that. */
export const MAX_APPEND_ATTEMPTS = 6;

export interface ChainEntryInput {
  owner:         string;
  op:            string;
  recordId:      string;
  fieldsChanged: string[];
  /** Already-encrypted before-image (or null). Not part of the hash — see hashEntry. */
  beforeImage:   string | null;
  /** Defaults to owner. */
  actorId?:      string;
}

export interface ChainHead {
  owner:     string;
  hash:      string;
  seq:       number;
  lastId:    string;
  ts:        string;
  /** ts of the first atomically-written entry for this owner. */
  cutoverTs: string;
  updatedAt: string;
}

export interface ChainTables {
  audit: string;
  head:  string;
}

export interface AppendOptions {
  maxAttempts?: number;
  sleep?:       (ms: number) => Promise<void>;
  now?:         () => string;
  uuid?:        () => string;
  random?:      () => number;
}

/** Minimal shape of a DynamoDBDocumentClient, so tests can pass a fake. */
export interface DocClientLike {
  send(command: any): Promise<any>;
}

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * The chain hash. Computed over the PLAINTEXT change summary, never the
 * encrypted before-image: AES-GCM uses a random IV per encryption, so the
 * ciphertext is non-deterministic and a hash over it could not be re-derived
 * by a verifier. The payload order is load-bearing — every row ever written
 * used exactly this order, and changing it would invalidate the whole log.
 */
export function hashEntry(e: {
  prevHash: string; ts: string; owner: string; op: string; recordId: string;
  fieldsChanged?: string[] | null;
}): string {
  const payload = [
    e.prevHash,
    e.ts,
    e.owner,
    e.op,
    e.recordId,
    [...(e.fieldsChanged || [])].sort().join(','),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Chain order. Atomic rows have a strictly increasing `seq` per owner and are
 * ordered by it — a millisecond timestamp can tie or, across two Lambda
 * containers with drifting clocks, invert. Legacy rows have only `ts`. A
 * legacy row always sorts before an atomic one: the cut-over is a point in
 * the chain, not a point in time.
 */
export function sortEntries<T extends { ts?: string; seq?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aSeq = typeof a.seq === 'number';
    const bSeq = typeof b.seq === 'number';
    if (aSeq && bSeq) return (a.seq as number) - (b.seq as number);
    if (aSeq !== bSeq) return aSeq ? 1 : -1;
    return (a.ts || '').localeCompare(b.ts || '');
  });
}

export interface WalkResult {
  ok:                boolean;
  entryCount:        number;
  ackedCount:        number;
  /** First UNACKNOWLEDGED post-cut-over break, or the first hash mismatch anywhere. */
  brokenAtId:        string | null;
  reason:            'prevHash mismatch' | 'hash mismatch' | null;
  /** Unacknowledged post-cut-over prevHash breaks. Anything above 0 is a real problem. */
  breakCount:        number;
  /** prevHash breaks before the cut-over. History, reported, not repairable. */
  legacyBreakCount:  number;
  /** Rows whose content does not hash to their stored hash. Never acceptable. */
  hashMismatchCount: number;
  /** ts of the first atomic row, or null if this owner has none yet. */
  cutoverTs:         string | null;
  chainVersion:      number;
}

/**
 * Walk an owner's whole log and say what is true about it.
 *
 * `ok` means: no content tampering anywhere, and no unacknowledged ordering
 * break after the cut-over. Legacy breaks do not make the chain "not ok" —
 * they are counted and shown, because the alternative (225 sequential
 * acknowledgements, or a green badge that hides them) is worse either way.
 */
export function walkChain(rawItems: any[]): WalkResult {
  const items = sortEntries(rawItems);
  const result: WalkResult = {
    ok: true, entryCount: items.length, ackedCount: 0, brokenAtId: null, reason: null,
    breakCount: 0, legacyBreakCount: 0, hashMismatchCount: 0, cutoverTs: null,
    chainVersion: CHAIN_VERSION,
  };
  if (items.length === 0) return result;

  // ACK rows point (via recordId) at the entry whose break they excuse. An ACK
  // row still has to chain validly itself; a forged one shows up as its own
  // break.
  const ackedIds = new Set<string>(
    items.filter(e => e.op === 'ACK_BREAK').map(e => String(e.recordId)),
  );

  let expectedPrev = GENESIS_PREV_HASH;
  let prevWasAtomic = false;
  let firstHashMismatchId: string | null = null;
  let firstBreakId: string | null = null;

  for (const entry of items) {
    const atomic = typeof entry.seq === 'number';
    if (atomic && result.cutoverTs === null) result.cutoverTs = entry.ts || null;

    if (entry.prevHash !== expectedPrev) {
      if (ackedIds.has(entry.id)) {
        result.ackedCount++;
      } else if (atomic && prevWasAtomic) {
        // Both sides of the gap were written atomically. This cannot be a
        // race; it is a missing or altered row.
        result.breakCount++;
        if (firstBreakId === null) firstBreakId = entry.id;
      } else {
        // At least one side is legacy — the pre-fix race, or the cut-over
        // itself landing on a forked head. History.
        result.legacyBreakCount++;
      }
    }

    if (hashEntry(entry) !== entry.hash) {
      result.hashMismatchCount++;
      if (firstHashMismatchId === null) firstHashMismatchId = entry.id;
    }

    expectedPrev = entry.hash;
    prevWasAtomic = atomic;
  }

  if (firstHashMismatchId !== null) {
    result.ok = false;
    result.brokenAtId = firstHashMismatchId;
    result.reason = 'hash mismatch';
  } else if (firstBreakId !== null) {
    result.ok = false;
    result.brokenAtId = firstBreakId;
    result.reason = 'prevHash mismatch';
  }
  return result;
}

// ── DynamoDB ─────────────────────────────────────────────────────────────────

export async function readHead(ddb: DocClientLike, headTable: string, owner: string): Promise<ChainHead | null> {
  const res = await ddb.send(new GetCommand({
    TableName: headTable,
    Key: { owner },
    ConsistentRead: true,   // the whole point is reading the head that was just written
  }));
  return (res && res.Item) ? (res.Item as ChainHead) : null;
}

/** Every AuditLog row for one owner. A scan — the table has no owner index. */
export async function scanOwnerEntries(ddb: DocClientLike, auditTable: string, owner: string): Promise<any[]> {
  const items: any[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const res: any = await ddb.send(new ScanCommand({
      TableName: auditTable,
      FilterExpression: '#o = :owner',
      ExpressionAttributeNames:  { '#o': 'owner' },
      ExpressionAttributeValues: { ':owner': owner },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(res.Items || []));
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return items;
}

/**
 * The hash a legacy (pre-head) chain ends on: newest row by ts. This is
 * exactly the rule the old appendAudit used, so the first atomic row chains
 * onto the same parent the old code would have chosen. Called once per owner,
 * the first time they write after the fix; never again once a head exists.
 */
export async function legacyLatestHash(ddb: DocClientLike, auditTable: string, owner: string): Promise<string> {
  const items = await scanOwnerEntries(ddb, auditTable, owner);
  if (items.length === 0) return GENESIS_PREV_HASH;
  const sorted = sortEntries(items);
  return sorted[sorted.length - 1].hash || GENESIS_PREV_HASH;
}

/**
 * True for a lost race that is safe and correct to retry: either
 *
 *  - a stale condition (ConditionalCheckFailed[Exception]) — another writer's
 *    TransactWriteItems already committed and moved the head out from under
 *    us, or
 *  - a live transaction lock (TransactionConflict[Exception], "Transaction is
 *    ongoing for the item") — another writer's transaction has the head item
 *    locked RIGHT NOW, in flight, not yet committed.
 *
 * Both are physical contention on one owner's chain-head item from the same
 * event — two writers hitting it at once — and the loop's response is
 * identical either way: re-read the head and try again. See
 * `isTransactionConflict` for why the backoff differs.
 */
function isConditionalCancel(err: any): boolean {
  if (!err) return false;
  if (err.name === 'ConditionalCheckFailedException') return true;
  if (err.name === 'TransactionConflictException') return true;
  if (err.name !== 'TransactionCanceledException') return false;
  const reasons: any[] = err.CancellationReasons || [];
  return reasons.some(r => r && (r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict'));
}

/**
 * Narrower check used only to pick a backoff: is this specifically a live
 * transaction lock, not a stale condition? A lock needs real wall-clock time
 * to clear — the competing transaction has to actually finish — where a
 * condition mismatch is retriable the instant the new head is visible. A
 * single TransactionCanceledException can carry mixed per-item reasons; any
 * TransactionConflict present is enough to use the wider window.
 */
function isTransactionConflict(err: any): boolean {
  if (!err) return false;
  if (err.name === 'TransactionConflictException') return true;
  if (err.name !== 'TransactionCanceledException') return false;
  const reasons: any[] = err.CancellationReasons || [];
  return reasons.some(r => r && r.Code === 'TransactionConflict');
}

/**
 * Append one entry to an owner's chain, atomically with the chain head.
 *
 * Returns the written row's id, hash, prevHash, ts and seq. Throws after
 * `maxAttempts` consecutive lost races, or immediately on any other error.
 */
export async function appendChained(
  ddb: DocClientLike,
  tables: ChainTables,
  input: ChainEntryInput,
  opts: AppendOptions = {},
): Promise<{ id: string; hash: string; prevHash: string; ts: string; seq: number }> {
  const maxAttempts = opts.maxAttempts ?? MAX_APPEND_ATTEMPTS;
  const sleep  = opts.sleep  ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now    = opts.now    ?? (() => new Date().toISOString());
  const uuid   = opts.uuid   ?? randomUUID;
  const random = opts.random ?? Math.random;

  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await readHead(ddb, tables.head, input.owner);

    // No head yet: this owner's first atomic write. Chain onto whatever the
    // legacy log ends on, and create the head conditioned on it still not
    // existing — two first-writers racing here collapse to one winner too.
    const prevHash = head ? head.hash : await legacyLatestHash(ddb, tables.audit, input.owner);
    const seq      = head ? head.seq + 1 : 1;
    const ts       = now();
    const id       = uuid();
    const hash     = hashEntry({ prevHash, ts, owner: input.owner, op: input.op,
                                 recordId: input.recordId, fieldsChanged: input.fieldsChanged });

    const entryItem: Record<string, unknown> = {
      id,
      owner:         input.owner,
      op:            input.op,
      recordId:      input.recordId,
      fieldsChanged: input.fieldsChanged,
      actorId:       input.actorId ?? input.owner,
      prevHash,
      hash,
      ts,
      seq,
      chainV:        CHAIN_VERSION,
      beforeImage:   input.beforeImage,
      createdAt:     ts,
      updatedAt:     ts,
      // Required for owner-based auth on Amplify-generated reads.
      __typename:    'AuditLog',
    };

    const headItem: ChainHead = {
      owner:     input.owner,
      hash,
      seq,
      lastId:    id,
      ts,
      cutoverTs: head ? head.cutoverTs : ts,
      updatedAt: ts,
    };

    // Typed explicitly: inferred as a union of the two literals, TypeScript
    // widens ExpressionAttributeNames to { '#h', '#s', '#o'?: undefined },
    // which is not a Record<string, string> and fails the repo's strict tsc.
    const headPut: {
      TableName: string;
      Item: Record<string, unknown>;
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    } = head
      ? {
          TableName: tables.head,
          Item: { ...headItem },
          ConditionExpression: '#h = :prev AND #s = :seq',
          ExpressionAttributeNames:  { '#h': 'hash', '#s': 'seq' },
          ExpressionAttributeValues: { ':prev': head.hash, ':seq': head.seq },
        }
      : {
          TableName: tables.head,
          Item: { ...headItem },
          ConditionExpression: 'attribute_not_exists(#o)',
          ExpressionAttributeNames: { '#o': 'owner' },
        };

    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tables.audit, Item: entryItem, ConditionExpression: 'attribute_not_exists(id)' } },
          { Put: headPut },
        ],
      }));
      return { id, hash, prevHash, ts, seq };
    } catch (err: any) {
      if (!isConditionalCancel(err)) throw err;
      lastErr = err;
      // Lost the race. Jittered pause so a burst of losers does not
      // re-collide. A live transaction lock gets a wider window than a stale
      // condition — see `isTransactionConflict`.
      const base = isTransactionConflict(err) ? 40 : 25;
      await sleep(Math.round(random() * base * attempt));
    }
  }
  const e = new Error(`Audit append lost ${maxAttempts} consecutive races for owner chain; giving up`);
  (e as any).cause = lastErr;
  throw e;
}
