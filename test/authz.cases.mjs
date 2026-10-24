// Cross-tenant authorization: the checks that stop one agent reading another
// agent's clients.
//
// ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// A security audit found a working cross-tenant data-theft chain in the
// scheduled Slack dispatcher. Three individually-minor facts composed into it:
//
//   1. An Appointment carries `clientRecordId`, an ordinary attribute written
//      through Amplify's auto-generated resolver — so the CLIENT picks its value
//      and nothing validates what it points at.
//   2. The dispatcher is a cron with table-wide IAM. It dereferenced that
//      pointer to fetch the linked Record's phone/carrier/product WITHOUT
//      comparing owners.
//   3. The reminder is posted to the webhook of the APPOINTMENT's owner.
//
// So: create an appointment you own, point clientRecordId at a stranger's
// record, and their client's contact details arrive in your Slack. Encryption
// was no help — phone, productLine, carrier and product sit outside
// secure-record's SENSITIVE_FIELDS on purpose, because they have to stay
// queryable, so the dispatcher read them in plaintext.
//
// The bug class is a CONFUSED DEPUTY. The dispatcher was never compromised; it
// was tricked into spending its own authority for someone else. The rule that
// generalises: whenever a privileged background job follows a reference a user
// can write, ownership has to be re-verified at the moment it is followed. The
// permission the JOB holds is not the permission the REQUESTER holds.
//
// `sameOwner` is where that comparison now lives. It gets its own file and its
// own exhaustive tests for the same reason isAdminDocKey does — it is a small
// string check that looks obviously correct, and the cost of it being subtly
// wrong is measured in disclosed client records.

import { suite, check, eq } from './lib/assert.mjs';
import { sameOwner } from '../amplify/shared/ownership.ts';
import { isAncestorPath, rootPath } from '../amplify/shared/tree.ts';

export default async function run() {

  suite('Tenant isolation — sameOwner allows the legitimate case');
  {
    eq('identical usernames match', sameOwner('agent@example.com', 'agent@example.com'), true);
    eq('identical subs match',
      sameOwner('4f9c1e2a-0000-4b8d-9f1a-1c2d3e4f5a6b', '4f9c1e2a-0000-4b8d-9f1a-1c2d3e4f5a6b'), true);
    eq('a single-character owner still matches itself', sameOwner('a', 'a'), true);

    // The reason the whole fix is safe to ship: for your OWN appointment the two
    // owners are the same string, so the client details still resolve exactly as
    // they did before. Nothing legitimate is lost.
    const record = { owner: 'agent@example.com', phone: '555-0100', carrier: 'Mutual of Omaha' };
    const appointment = { owner: 'agent@example.com', clientRecordId: 'rec-1' };
    check('an agent still gets their own client details',
      sameOwner(record.owner, appointment.owner),
      'the reminder must keep working for the owner — this is the non-regression case');
  }

  suite('Tenant isolation — sameOwner refuses the attack');
  {
    const victimRecord   = { owner: 'victim@example.com', phone: '555-0199' };
    const attackerAppt   = { owner: 'attacker@example.com', clientRecordId: 'victim-record-id' };

    check('an appointment cannot join to another tenant\'s record',
      !sameOwner(victimRecord.owner, attackerAppt.owner),
      'THE finding — this is the comparison that stops the exfiltration chain');

    eq('different usernames do not match',
      sameOwner('attacker@example.com', 'victim@example.com'), false);

    // Near-miss shapes, because owner values are compared as opaque strings and
    // an attacker controls their own signup email.
    eq('case differences do not match', sameOwner('Agent@example.com', 'agent@example.com'), false);
    eq('leading whitespace does not match', sameOwner(' agent@example.com', 'agent@example.com'), false);
    eq('trailing whitespace does not match', sameOwner('agent@example.com ', 'agent@example.com'), false);
    eq('a prefix does not match', sameOwner('agent@example.co', 'agent@example.com'), false);
    eq('a superstring does not match', sameOwner('agent@example.command', 'agent@example.com'), false);
    eq('the sub::username form does not match a bare username',
      sameOwner('abc-123::agent@example.com', 'agent@example.com'), false);
  }

  suite('Tenant isolation — sameOwner fails CLOSED on absent values');
  {
    // The failure mode that makes this a function instead of an inline `===`.
    // Both sides are DATA, not identity — an attacker can hunt for rows that
    // never got an owner stamped. `undefined === undefined` is true, and so is
    // `'' === ''`, so a naive comparison would let one unowned row read another.
    eq('two undefined owners are NOT the same tenant', sameOwner(undefined, undefined), false);
    eq('two null owners are NOT the same tenant', sameOwner(null, null), false);
    eq('two empty strings are NOT the same tenant', sameOwner('', ''), false);

    eq('undefined never matches a real owner', sameOwner(undefined, 'agent@example.com'), false);
    eq('a real owner never matches undefined', sameOwner('agent@example.com', undefined), false);
    eq('null never matches a real owner', sameOwner(null, 'agent@example.com'), false);
    eq('empty never matches a real owner', sameOwner('', 'agent@example.com'), false);

    // A record whose owner attribute was never projected reads as undefined.
    // That must not be treated as a match — it is the exact shape produced by
    // forgetting '#o' in the ProjectionExpression.
    const unprojected = { phone: '555-0199' };
    check('a record with no projected owner is refused',
      !sameOwner(unprojected.owner, 'attacker@example.com'),
      'dropping #o from the projection must fail closed, not open');
  }

  suite('Tenant isolation — sameOwner refuses type confusion');
  {
    // DynamoDB attributes are whatever was written. A non-string owner should
    // never satisfy the check by coercion.
    for (const [label, value] of [
      ['a number', 1], ['zero', 0], ['true', true], ['false', false],
      ['an array', ['agent@example.com']], ['an object', { toString: () => 'agent@example.com' }],
      ['NaN', NaN],
    ]) {
      eq(`${label} never matches a real owner`, sameOwner(value, 'agent@example.com'), false);
      eq(`a real owner never matches ${label}`, sameOwner('agent@example.com', value), false);
      eq(`${label} does not match itself`, sameOwner(value, value), false);
    }
  }

  // ── A-03: who may repair whose breadcrumbs ────────────────────────────────
  //
  // agencyVerifyPaths rewrites `path` and `rootNodeId`. Those two fields ARE the
  // inputs to every other authorization decision in the hierarchy: getStats
  // compares rootNodeId to decide whether byNode crosses, and isAncestorPath
  // reads path to gate every downward action. So an unscoped repair let any
  // member of a fragment rewrite the fields the rest of the system trusts —
  // on their uplines' nodes, which they can do nothing else to.
  //
  // The rule mirrored below is the one in verifyPaths(). It is duplicated here
  // the same way hierarchy-ops.cases.mjs mirrors the move guard: the rule is
  // what is under test, not the wiring. Keep the expression identical to the
  // handler's so a divergence is visible at a glance.
  suite('Hierarchy repair — scoped to self and downline, fails closed');
  {
    const repairable = (meId, myPath, nodeId, expectedPath) =>
      nodeId === meId || isAncestorPath(myPath, expectedPath);

    const me       = { id: 'me',  path: rootPath('root') + 'me/' };
    const myPath   = me.path;

    const child    = myPath + 'kid/';
    const grandkid = myPath + 'kid/gk/';
    const upline   = rootPath('root');
    const sibling  = rootPath('root') + 'sib/';

    check('a producer may repair their own node',
      repairable(me.id, myPath, 'me', myPath), 'self-repair is the normal case');
    check('a producer may repair a direct downline',
      repairable(me.id, myPath, 'kid', child), '');
    check('a producer may repair a deep downline',
      repairable(me.id, myPath, 'gk', grandkid), '');

    check('a producer may NOT repair their upline',
      !repairable(me.id, myPath, 'root', upline),
      'ability travels downward only (§5.2, §8.6) — this was the finding');
    check('a producer may NOT repair a sibling branch',
      !repairable(me.id, myPath, 'sib', sibling), '');
    check('a producer may NOT repair a node in another fragment',
      !repairable(me.id, myPath, 'other', rootPath('otherroot') + 'x/'), '');

    // The prefix trap: '/root/me/' must not be treated as an ancestor of
    // '/root/mentor/'. Pinned in producer-tree.cases.mjs for isAncestorPath
    // itself; pinned again here because THIS is where it would be a privilege
    // escalation rather than a display bug.
    check('a name-prefix collision is not a downline',
      !repairable(me.id, rootPath('root') + 'me/', 'mentor', rootPath('root') + 'mentor/'),
      'startsWith on unterminated paths would make /root/me/ an ancestor of /root/mentor/');

    // expected.get(id) returns undefined for a node the recompute did not cover.
    // isAncestorPath must refuse it rather than coerce.
    check('a node with no recomputed path is refused',
      !repairable(me.id, myPath, 'ghost', undefined),
      'an unknown target must fail closed, not open');
    check('a caller with no path of their own repairs nothing but themselves',
      !repairable(me.id, undefined, 'kid', child), '');
    check('...but can still repair their own node',
      repairable(me.id, undefined, 'me', myPath), 'self is matched by id, not by path');
  }
}
