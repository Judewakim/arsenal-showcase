// ════════════════════════════════════════════════════════════════════════════
// Safe logging for handlers that touch PHI, PII and secrets.
//
// WHY THIS EXISTS. Every Lambda that dispatches on `event.fieldName` opened with
// the same defensive line:
//
//   console.error('No fieldName on event:', JSON.stringify(event));
//
// On a secureCreateRecord call, `event.arguments.input` IS the client's complete
// unencrypted record — SSN, bank routing and account, card number, CVV, and the
// whole medical history. So that one line takes the exact payload the Lambda
// exists to encrypt and writes it, in the clear, to a CloudWatch log group that
// has no retention limit and no CMK. It lands OUTSIDE the encryption boundary
// the function was built to enforce.
//
// It only fires when `fieldName` is missing, which should not happen through
// AppSync. That is what kept it in the codebase: it looked unreachable, so it
// looked harmless. But the cost of removing it is two lines and the cost of it
// firing once is a reportable HIPAA incident, and that asymmetry — not the
// likelihood — is the reason it matters.
//
// The bug class is debug logging that outlived the debugging. Any
// `JSON.stringify` of a request, event, or argument object is a latent
// disclosure, because the thing being serialized grows new sensitive fields
// over time while the log line never changes.
//
// THE RULE THIS MODULE ENFORCES: log the SHAPE of untrusted input, never its
// VALUES. Key names, counts and booleans are enough to debug a malformed
// invocation. The values are never needed, and they are the entire risk.
//
// test/log-hygiene.cases.mjs scans amplify/ and fails the build if a raw event
// dump comes back.
// ════════════════════════════════════════════════════════════════════════════

/** The loose shape every AppSync handler in this codebase receives. */
interface LoggableEvent {
  fieldName?: string;
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
  identity?: unknown;
}

/**
 * Summarize an AppSync event for a log line, without emitting any argument
 * VALUES.
 *
 * Deliberately an allow-list of derived facts rather than a deny-list of known
 * sensitive keys. A deny-list would need updating every time the live-call form
 * grows a field, and the failure mode of forgetting is silent disclosure — the
 * same trap that makes `SENSITIVE_FIELDS` a maintenance burden in
 * secure-record. Nothing here can leak a value, so nothing here needs updating.
 *
 * `argKeys` is the diagnostically useful part: a malformed invocation is almost
 * always "wrong operation" or "missing argument", and the key names answer both.
 */
export function eventShape(event: unknown): Record<string, unknown> {
  const e = (event ?? {}) as LoggableEvent;
  const args = e.arguments && typeof e.arguments === 'object' ? e.arguments : {};
  return {
    fieldName:     typeof e.fieldName === 'string' ? e.fieldName : null,
    infoFieldName: typeof e.info?.fieldName === 'string' ? e.info.fieldName : null,
    argKeys:       Object.keys(args).sort(),
    hasIdentity:   Boolean(e.identity),
  };
}

/**
 * Describe a secret well enough to diagnose a misconfiguration, without
 * printing any of it.
 *
 * The three ways a webhook secret is wrong in practice are: unset, set to
 * something that isn't a URL, and set to a real URL that the remote end
 * rejects. Presence, length and scheme separate all three — the characters do
 * not add anything a maintainer can act on.
 *
 * Length is included deliberately and is safe: it distinguishes "empty string"
 * from "placeholder" from "real value" and reveals nothing usable about the
 * content.
 */
export function describeSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unset/empty';
  const scheme = value.startsWith('https://') ? 'https'
               : value.startsWith('http://')  ? 'http (insecure)'
               : 'no recognised scheme';
  return `${value.length} chars, ${scheme}`;
}
