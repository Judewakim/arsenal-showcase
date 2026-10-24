// ════════════════════════════════════════════════════════════════════════════
// Owner equality, for the places where one row points at another.
//
// WHY THIS EXISTS. Most tenant isolation in this codebase compares the caller's
// identity to a row's `owner`, and the caller's identity comes from AppSync, so
// it is always a real string. Those checks are fine written inline.
//
// The scheduled dispatcher is different. It has no caller. It runs with
// table-wide IAM across every tenant, and it follows a pointer — an
// Appointment's `clientRecordId` — to fetch the linked Record. Both sides of
// that comparison are attacker-influenceable data rather than identity:
//
//   Appointment.owner       — whoever created the appointment (the attacker)
//   Record.owner            — whoever owns the record being pointed at
//
// Comparing two pieces of data with `===` has a failure mode that comparing
// against an identity does not: if BOTH sides are absent, they are equal, and a
// naive check returns true. `undefined === undefined` is `true`. `'' === ''` is
// `true`. A row that failed to get an owner stamped would then be readable by a
// row that also failed to get one — which is precisely the population of
// malformed rows an attacker would go looking for.
//
// So this check fails closed on anything that is not two identical non-empty
// strings. That is the whole point of it being a named function with its own
// tests rather than an inline `===`.
//
// See test/authz.cases.mjs.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Do these two owner values refer to the same tenant?
 *
 * Fail-closed by construction: absent, empty, and non-string values are never
 * equal to anything, including each other.
 *
 * Deliberately NOT a general-purpose equality helper — it exists to make
 * "same tenant" a decision with one implementation and one set of tests.
 */
export function sameOwner(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  return a === b;
}
