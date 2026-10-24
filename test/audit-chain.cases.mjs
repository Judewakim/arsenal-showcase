// The audit hash chain, appended atomically and verified honestly (A-09).
//
// What went wrong, in one sentence: appendAudit read the latest hash and then
// wrote, with nothing between, so two autosaves 20 ms apart both chained off
// the same parent — 225 forks on one owner by September 2026, none of them
// tampering, all of them making tampering undetectable.
//
// These tests drive the real shared module against an in-memory DynamoDB
// stand-in that honours the two things that matter: ConditionExpressions on
// the head, and all-or-nothing transactions. The race is reproduced literally
// — two appends that both read the head before either commits — and the
// assertion is that both land, in sequence, with the second chained onto the
// first. That is the case the old code failed.

import { suite, check, eq, deepEq } from './lib/assert.mjs';
import {
  GetCommand, ScanCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GENESIS_PREV_HASH, CHAIN_VERSION, hashEntry, sortEntries, walkChain,
  appendChained, legacyLatestHash, readHead,
} from '../amplify/shared/audit-chain.ts';

// ── An in-memory DynamoDB that is faithful where it counts ──────────────────

function fakeDdb() {
  const tables = { audit: new Map(), head: new Map() };
  const log = [];

  function keyOf(table, item) {
    return table === 'head' ? item.owner : item.id;
  }

  function checkCondition(table, put) {
    const existing = tables[table].get(keyOf(table, put.Item));
    const expr = put.ConditionExpression || '';
    if (expr === 'attribute_not_exists(id)' || expr === 'attribute_not_exists(#o)') {
      return existing === undefined;
    }
    if (expr === '#h = :prev AND #s = :seq') {
      if (!existing) return false;
      const v = put.ExpressionAttributeValues;
      return existing.hash === v[':prev'] && existing.seq === v[':seq'];
    }
    throw new Error(`fake ddb: unknown condition ${expr}`);
  }

  return {
    tables, log,
    async send(cmd) {
      log.push(cmd.constructor.name);
      if (cmd instanceof GetCommand) {
        const t = cmd.input.TableName;
        return { Item: tables[t].get(cmd.input.Key.owner) };
      }
      if (cmd instanceof ScanCommand) {
        const owner = cmd.input.ExpressionAttributeValues[':owner'];
        const all = [...tables[cmd.input.TableName].values()].filter(i => i.owner === owner);
        // Two pages, to prove pagination is followed.
        const start = cmd.input.ExclusiveStartKey ? cmd.input.ExclusiveStartKey.n : 0;
        const page = all.slice(start, start + 2);
        const next = start + 2 < all.length ? { n: start + 2 } : undefined;
        return { Items: page, LastEvaluatedKey: next };
      }
      if (cmd instanceof TransactWriteCommand) {
        const puts = cmd.input.TransactItems.map(t => t.Put);
        const reasons = puts.map(p => checkCondition(p.TableName, p) ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' });
        if (reasons.some(r => r.Code === 'ConditionalCheckFailed')) {
          const err = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = reasons;
          throw err;
        }
        for (const p of puts) tables[p.TableName].set(keyOf(p.TableName, p.Item), structuredClone(p.Item));
        return {};
      }
      throw new Error(`fake ddb: unhandled ${cmd.constructor.name}`);
    },
  };
}

const TABLES = { audit: 'audit', head: 'head' };
const noSleep = { sleep: async () => {}, random: () => 0 };

let clock = 0;
const tick = () => new Date(1_757_000_000_000 + (clock++) * 1000).toISOString();

function legacyRow(owner, prevHash, op, recordId, ts, id) {
  const row = { id, owner, op, recordId, fieldsChanged: ['name'], prevHash, ts, actorId: owner };
  row.hash = hashEntry(row);
  return row;
}

export default async function run() {
  suite('Audit chain — the hash is what it always was');

  const h = hashEntry({ prevHash: 'GENESIS', ts: '2026-01-01T00:00:00.000Z', owner: 'u', op: 'CREATE', recordId: 'r', fieldsChanged: ['b', 'a'] });
  eq('sha256 hex', h.length, 64);
  eq('fieldsChanged is sorted before hashing (b,a == a,b)',
     h, hashEntry({ prevHash: 'GENESIS', ts: '2026-01-01T00:00:00.000Z', owner: 'u', op: 'CREATE', recordId: 'r', fieldsChanged: ['a', 'b'] }));
  check('a different prevHash is a different hash',
        h !== hashEntry({ prevHash: 'x', ts: '2026-01-01T00:00:00.000Z', owner: 'u', op: 'CREATE', recordId: 'r', fieldsChanged: ['a', 'b'] }));
  eq('missing fieldsChanged hashes like an empty list',
     hashEntry({ prevHash: 'G', ts: 't', owner: 'u', op: 'X', recordId: 'r' }),
     hashEntry({ prevHash: 'G', ts: 't', owner: 'u', op: 'X', recordId: 'r', fieldsChanged: [] }));

  suite('Audit chain — ordering');

  const ordered = sortEntries([
    { id: 'c', seq: 2, ts: '2026-09-09T00:00:01Z' },
    { id: 'a', ts: '2026-09-01T00:00:00Z' },
    { id: 'd', seq: 1, ts: '2026-09-09T00:00:05Z' },   // later ts, lower seq
    { id: 'b', ts: '2026-09-02T00:00:00Z' },
  ]);
  deepEq('legacy rows by ts, then atomic rows by seq — seq beats ts',
         ordered.map(x => x.id), ['a', 'b', 'd', 'c']);

  suite('Audit chain — the race, reproduced');

  {
    const ddb = fakeDdb();
    // Both writers read the head (none yet) BEFORE either commits. This is the
    // 20 ms autosave pair that forked the chain in production.
    const [x, y] = await Promise.all([
      appendChained(ddb, TABLES, { owner: 'u1', op: 'UPDATE', recordId: 'r1', fieldsChanged: ['a'], beforeImage: null }, { ...noSleep, now: tick }),
      appendChained(ddb, TABLES, { owner: 'u1', op: 'UPDATE', recordId: 'r1', fieldsChanged: ['b'], beforeImage: null }, { ...noSleep, now: tick }),
    ]);
    const [first, second] = [x, y].sort((p, q) => p.seq - q.seq);
    eq('both writes landed', ddb.tables.audit.size, 2);
    deepEq('they took sequence numbers 1 and 2', [first.seq, second.seq], [1, 2]);
    eq('the first chains onto GENESIS', first.prevHash, GENESIS_PREV_HASH);
    eq('the second chains onto the FIRST, not onto GENESIS', second.prevHash, first.hash);
    check('one of them had to retry (a transaction was cancelled)',
          ddb.log.filter(n => n === 'TransactWriteCommand').length === 3);
    const head = await readHead(ddb, 'head', 'u1');
    eq('the head is the second write', head.hash, second.hash);
    eq('the head seq is 2', head.seq, 2);
    eq('the cut-over is the first atomic write', head.cutoverTs, first.ts);
    const walk = walkChain([...ddb.tables.audit.values()]);
    check('and the chain verifies', walk.ok);
    eq('with zero breaks of any kind', walk.breakCount + walk.legacyBreakCount + walk.hashMismatchCount, 0);
    eq('rows carry the chain version', [...ddb.tables.audit.values()][0].chainV, CHAIN_VERSION);
  }

  suite('Audit chain — a burst of five');

  {
    const ddb = fakeDdb();
    const results = await Promise.all([1, 2, 3, 4, 5].map(i =>
      appendChained(ddb, TABLES, { owner: 'u2', op: 'UPDATE', recordId: 'r', fieldsChanged: [`f${i}`], beforeImage: null }, { ...noSleep, now: tick })));
    deepEq('five sequence numbers, no gaps, no duplicates',
           results.map(r => r.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    const walk = walkChain([...ddb.tables.audit.values()]);
    check('a five-way race still verifies', walk.ok);
    eq('five entries', walk.entryCount, 5);
  }

  suite('Audit chain — giving up is loud, not silent');

  {
    const ddb = fakeDdb();
    // A head that changes under us every single time.
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        const err = new Error('cancelled'); err.name = 'TransactionCanceledException';
        err.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
        throw err;
      }
      return realSend(cmd);
    };
    let thrown = null;
    try {
      await appendChained(ddb, TABLES, { owner: 'u3', op: 'UPDATE', recordId: 'r', fieldsChanged: [], beforeImage: null }, { ...noSleep, maxAttempts: 4 });
    } catch (e) { thrown = e; }
    check('throws after maxAttempts', !!thrown && /lost 4 consecutive races/.test(thrown.message));
    eq('tried exactly maxAttempts times', n, 4);
    check('the last cancellation is on .cause', thrown.cause && thrown.cause.name === 'TransactionCanceledException');
    eq('nothing was written', ddb.tables.audit.size, 0);
  }

  {
    const ddb = fakeDdb();
    ddb.send = async () => { const e = new Error('boom'); e.name = 'ProvisionedThroughputExceededException'; throw e; };
    let thrown = null;
    try { await appendChained(ddb, TABLES, { owner: 'u', op: 'X', recordId: 'r', fieldsChanged: [], beforeImage: null }, noSleep); }
    catch (e) { thrown = e; }
    check('a non-conditional error is NOT retried — it surfaces at once', thrown && thrown.name === 'ProvisionedThroughputExceededException');
  }

  {
    // A genuinely non-retriable error (schema/validation, not contention)
    // must fail fast: one attempt, zero sleeps. This is the regression guard
    // against the retriable predicate widening into "retry everything".
    const ddb = fakeDdb();
    let attempts = 0;
    let slept = 0;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        attempts++;
        const e = new Error('field too long'); e.name = 'ValidationException';
        throw e;
      }
      return realSend(cmd);
    };
    let thrown = null;
    try {
      await appendChained(
        ddb, TABLES,
        { owner: 'u6a', op: 'UPDATE', recordId: 'r', fieldsChanged: [], beforeImage: null },
        { random: () => 1, sleep: async () => { slept++; }, now: tick },
      );
    } catch (e) { thrown = e; }
    check('a ValidationException is not retried', thrown && thrown.name === 'ValidationException');
    eq('exactly one attempt was made — it did not survive to a second', attempts, 1);
    eq('sleep was never called', slept, 0);
  }

  suite('Audit chain — TransactionConflict is a busy signal, not a break');

  {
    // A head write that reports TransactionConflict (the live-lock case, not
    // a stale condition) on its first two attempts, then succeeds. This is
    // what staging actually saw: DynamoDB refusing a concurrent transaction
    // on the same head item, not a ConditionalCheckFailed.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    const delays = [];
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n <= 2) {
          const err = new Error('Transaction is ongoing for the item');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'None' }, { Code: 'TransactionConflict' }];
          throw err;
        }
      }
      return realSend(cmd);
    };
    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u6', op: 'UPDATE', recordId: 'r', fieldsChanged: ['a'], beforeImage: null },
      { random: () => 1, sleep: async (ms) => { delays.push(ms); }, now: tick },
    );
    eq('third attempt succeeded', n, 3);
    check('the row landed', ddb.tables.audit.has(result.id));
    eq('chains onto genesis, same as any other first write', result.prevHash, GENESIS_PREV_HASH);
    deepEq('TransactionConflict backs off wider than a stale condition (base 40ms, attempts 1 then 2)',
           delays, [40, 80]);
  }

  {
    // A mix: the first loss is a live lock, the second a stale condition
    // (another writer's commit already landed by the time we retried), then
    // success. Both codes must retry through the same loop.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n === 1) {
          const err = new Error('Transaction is ongoing for the item');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'TransactionConflict' }, { Code: 'None' }];
          throw err;
        }
        if (n === 2) {
          const err = new Error('Conditional check failed');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
          throw err;
        }
      }
      return realSend(cmd);
    };
    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u7', op: 'UPDATE', recordId: 'r', fieldsChanged: ['a'], beforeImage: null },
      noSleep,
    );
    eq('third attempt succeeded (conflict, then condition, then success)', n, 3);
    check('the row landed', ddb.tables.audit.has(result.id));
  }

  {
    // A bare TransactionConflictException (no TransactionCanceledException
    // wrapper) — DynamoDB's SDK can surface the conflict this way directly on
    // a single-item transaction, same as ConditionalCheckFailedException is
    // handled bare today.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n === 1) {
          const err = new Error('Transaction is ongoing for the item');
          err.name = 'TransactionConflictException';
          throw err;
        }
      }
      return realSend(cmd);
    };
    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u8', op: 'UPDATE', recordId: 'r', fieldsChanged: ['a'], beforeImage: null },
      noSleep,
    );
    eq('a bare TransactionConflictException retries too', n, 2);
    check('the row landed', ddb.tables.audit.has(result.id));
  }

  {
    // A stale condition ALONE (no TransactionConflict anywhere in the
    // reasons) must take the NARROWER backoff. Pinned with a fixed random so
    // the 25ms base cannot silently drift or collapse to the 40ms one — the
    // transaction-only case above already pins 40; this pins the other half
    // of the 40-vs-25 split.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    const delays = [];
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n <= 2) {
          const err = new Error('Conditional check failed');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
          throw err;
        }
      }
      return realSend(cmd);
    };
    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u6b', op: 'UPDATE', recordId: 'r', fieldsChanged: ['a'], beforeImage: null },
      { random: () => 1, sleep: async (ms) => { delays.push(ms); }, now: tick },
    );
    eq('third attempt succeeded', n, 3);
    check('the row landed', ddb.tables.audit.has(result.id));
    deepEq('a stale condition alone backs off narrower than a transaction lock (base 25ms, attempts 1 then 2)',
           delays, [25, 50]);
  }

  {
    // ONE error reporting BOTH reasons at once (a single TransactWriteItems
    // cancellation can carry a different code per item). The loop must still
    // take the WIDER transaction backoff whenever TransactionConflict is
    // present among the reasons, even mixed with ConditionalCheckFailed —
    // this is the "checks transaction first" ordering the fix encodes.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    const delays = [];
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n === 1) {
          const err = new Error('mixed cancellation');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'TransactionConflict' }, { Code: 'ConditionalCheckFailed' }];
          throw err;
        }
      }
      return realSend(cmd);
    };
    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u6c', op: 'UPDATE', recordId: 'r', fieldsChanged: ['a'], beforeImage: null },
      { random: () => 1, sleep: async (ms) => { delays.push(ms); }, now: tick },
    );
    eq('second attempt succeeded (one mixed cancellation, then success)', n, 2);
    check('the row landed', ddb.tables.audit.has(result.id));
    deepEq('mixed reasons in ONE error take the wider transaction backoff (40ms), not the condition one (25ms)',
           delays, [40]);
  }

  {
    // Prove the retry RE-READS the head rather than replaying a stale one: a
    // rival writer's commit lands for real between our failed attempt and our
    // retry, moving the head. If the loop cached the head read before the
    // conflict, the retried write would chain onto the wrong parent (or fail
    // the condition again). It must chain onto whatever is current.
    const ddb = fakeDdb();
    const seed = await appendChained(
      ddb, TABLES,
      { owner: 'u10', op: 'UPDATE', recordId: 'r', fieldsChanged: ['seed'], beforeImage: null },
      { ...noSleep, now: tick },
    );

    let n = 0;
    let rivalHash = null;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        if (n === 1) {
          const rivalTs = tick();
          rivalHash = hashEntry({
            prevHash: seed.hash, ts: rivalTs, owner: 'u10', op: 'UPDATE', recordId: 'r', fieldsChanged: ['rival'],
          });
          ddb.tables.audit.set('RIVAL', {
            id: 'RIVAL', owner: 'u10', op: 'UPDATE', recordId: 'r', fieldsChanged: ['rival'],
            actorId: 'u10', prevHash: seed.hash, hash: rivalHash, ts: rivalTs, seq: seed.seq + 1,
            chainV: CHAIN_VERSION,
          });
          ddb.tables.head.set('u10', {
            owner: 'u10', hash: rivalHash, seq: seed.seq + 1, lastId: 'RIVAL', ts: rivalTs,
            cutoverTs: seed.ts, updatedAt: rivalTs,
          });
          const err = new Error('Transaction is ongoing for the item');
          err.name = 'TransactionConflictException';
          throw err;
        }
      }
      return realSend(cmd);
    };

    const result = await appendChained(
      ddb, TABLES,
      { owner: 'u10', op: 'UPDATE', recordId: 'r', fieldsChanged: ['b'], beforeImage: null },
      { ...noSleep, now: tick },
    );
    eq('retried exactly once', n, 2);
    eq('chains onto the RIVAL that landed during our OWN retry, not the head read before the conflict',
       result.prevHash, rivalHash);
    eq('sequence follows the rival, not the stale seed', result.seq, seed.seq + 2);
  }

  {
    // Budget exhausted on TransactionConflict alone: still throws, still
    // loud, and the last error (a conflict, not a condition failure) is on
    // .cause.
    const ddb = fakeDdb();
    let n = 0;
    const realSend = ddb.send.bind(ddb);
    ddb.send = async (cmd) => {
      if (cmd instanceof TransactWriteCommand) {
        n++;
        const err = new Error('Transaction is ongoing for the item');
        err.name = 'TransactionConflictException';
        throw err;
      }
      return realSend(cmd);
    };
    let thrown = null;
    try {
      await appendChained(ddb, TABLES, { owner: 'u9', op: 'UPDATE', recordId: 'r', fieldsChanged: [], beforeImage: null }, { ...noSleep, maxAttempts: 4 });
    } catch (e) { thrown = e; }
    check('throws after maxAttempts even when every loss is TransactionConflict',
          !!thrown && /lost 4 consecutive races/.test(thrown.message));
    eq('tried exactly maxAttempts times', n, 4);
    check('the last conflict is on .cause', thrown.cause && thrown.cause.name === 'TransactionConflictException');
    eq('nothing was written', ddb.tables.audit.size, 0);
  }

  suite('Audit chain — taking over a legacy chain');

  {
    const ddb = fakeDdb();
    // A pre-fix log: three rows, the third and second both chained off the
    // first (the fork), no head item anywhere.
    const a = legacyRow('u4', GENESIS_PREV_HASH, 'CREATE', 'r', '2026-06-01T00:00:00.000Z', 'A');
    const b = legacyRow('u4', a.hash, 'UPDATE', 'r', '2026-06-01T00:00:01.000Z', 'B');
    const c = legacyRow('u4', a.hash, 'UPDATE', 'r', '2026-06-01T00:00:01.020Z', 'C');   // the fork
    for (const r of [a, b, c]) ddb.tables.audit.set(r.id, r);

    eq('legacyLatestHash picks the newest by ts (across scan pages)', await legacyLatestHash(ddb, 'audit', 'u4'), c.hash);

    const before = walkChain([a, b, c]);
    check('before any atomic write the fork is visible', !before.ok || before.legacyBreakCount === 1);
    eq('...counted as a legacy break', before.legacyBreakCount, 1);
    eq('...with no post-cut-over break', before.breakCount, 0);
    check('...and the chain is reported ok — history, not an alarm', before.ok);
    eq('...with no cut-over yet', before.cutoverTs, null);

    const d = await appendChained(ddb, TABLES, { owner: 'u4', op: 'UPDATE', recordId: 'r', fieldsChanged: ['z'], beforeImage: null }, { ...noSleep, now: tick });
    eq('the first atomic row chains onto the legacy tail', d.prevHash, c.hash);
    eq('and is seq 1', d.seq, 1);
    check('a head now exists', !!(await readHead(ddb, 'head', 'u4')));
    const scansBefore = ddb.log.filter(n => n === 'ScanCommand').length;
    await appendChained(ddb, TABLES, { owner: 'u4', op: 'UPDATE', recordId: 'r', fieldsChanged: ['y'], beforeImage: null }, { ...noSleep, now: tick });
    eq('the legacy scan is not consulted again once a head exists',
       ddb.log.filter(n => n === 'ScanCommand').length - scansBefore, 0);

    const after = walkChain([...ddb.tables.audit.values()]);
    check('after the cut-over the chain is ok', after.ok);
    eq('the legacy fork is still on record', after.legacyBreakCount, 1);
    eq('the cut-over is the first atomic row', after.cutoverTs, d.ts);
  }

  suite('Audit chain — what the verifier reports');

  {
    // Legacy: A ← B, A ← C (fork), then atomic D ← E ← F.
    const a = legacyRow('u5', GENESIS_PREV_HASH, 'CREATE', 'r', '2026-06-01T00:00:00.000Z', 'A');
    const b = legacyRow('u5', a.hash, 'UPDATE', 'r', '2026-06-01T00:00:01.000Z', 'B');
    const c = legacyRow('u5', a.hash, 'UPDATE', 'r', '2026-06-01T00:00:01.020Z', 'C');
    const mk = (prev, seq, id, ts) => {
      const row = { id, owner: 'u5', op: 'UPDATE', recordId: 'r', fieldsChanged: [], prevHash: prev, ts, seq, chainV: 2 };
      row.hash = hashEntry(row); return row;
    };
    const d = mk(c.hash, 1, 'D', '2026-09-10T00:00:00.000Z');
    const e = mk(d.hash, 2, 'E', '2026-09-10T00:00:01.000Z');
    const f = mk(e.hash, 3, 'F', '2026-09-10T00:00:02.000Z');

    const clean = walkChain([f, b, d, a, e, c]);   // shuffled on purpose
    check('a legacy fork followed by a clean atomic run is ok', clean.ok);
    eq('entryCount', clean.entryCount, 6);
    eq('legacyBreakCount', clean.legacyBreakCount, 1);
    eq('breakCount', clean.breakCount, 0);

    // Delete E: F's prevHash no longer matches D's hash, and both are atomic.
    const gap = walkChain([a, b, c, d, f]);
    check('a missing atomic row is NOT ok', !gap.ok);
    eq('it is reported at the row after the gap', gap.brokenAtId, 'F');
    eq('as a prevHash mismatch', gap.reason, 'prevHash mismatch');
    eq('breakCount 1', gap.breakCount, 1);
    eq('the legacy fork is still counted separately', gap.legacyBreakCount, 1);

    // Tamper with B's content: its stored hash no longer matches.
    const tampered = { ...b, fieldsChanged: ['ssn'] };
    const t = walkChain([a, tampered, c, d, e, f]);
    check('altered content is NOT ok even in the legacy region', !t.ok);
    eq('hash mismatch wins over everything', t.reason, 'hash mismatch');
    eq('at the altered row', t.brokenAtId, 'B');
    eq('hashMismatchCount', t.hashMismatchCount, 1);

    // Delete E, then add an ACK_BREAK row pointing at F.
    const ack = mk(f.hash, 4, 'ACK', '2026-09-10T00:00:03.000Z');
    ack.op = 'ACK_BREAK'; ack.recordId = 'F'; ack.hash = hashEntry(ack);
    const acked = walkChain([a, b, c, d, f, ack]);
    check('an acknowledged post-cut-over break is ok again', acked.ok);
    eq('ackedCount 1', acked.ackedCount, 1);
    eq('breakCount back to 0', acked.breakCount, 0);

    // Two missing atomic rows: the OLD verifier would have reported 1.
    const g = mk(f.hash, 4, 'G', '2026-09-10T00:00:03.000Z');
    const hRow = mk(g.hash, 5, 'H', '2026-09-10T00:00:04.000Z');
    const two = walkChain([a, b, c, d, f, hRow]);   // E and G missing
    eq('the verifier counts every break, not just the first', two.breakCount, 2);
    eq('and points at the first one', two.brokenAtId, 'F');

    const empty = walkChain([]);
    check('an empty log is ok', empty.ok && empty.entryCount === 0);
  }
}
