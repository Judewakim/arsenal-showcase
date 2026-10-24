// Twilio request-signature verification. Closes F-10 (VENDOR_MANAGEMENT.md:155
// makes this a BLOCKING gate before any client data reaches Twilio) and is a
// dependency for T-143 and T-138.
//
// Twilio's scheme (https://www.twilio.com/docs/usage/security#validating-requests):
//   1. Take the full request URL exactly as Twilio invoked it (scheme, host,
//      path, and query string if present).
//   2. If the request is a POST with a form-encoded body, sort the POST
//      parameters by key and append each key immediately followed by its
//      value (no separator) to the URL string.
//   3. Compute HMAC-SHA1 of that string, keyed with the Twilio auth token.
//   4. Base64-encode the digest and compare it to the `X-Twilio-Signature`
//      header, in CONSTANT TIME.
//
// The auth token is a PARAMETER, never a module-level env read: T-143 calls
// this same helper with a per-subaccount token looked up at runtime (one
// producer's brand/campaign, not a single platform-wide secret), so baking in
// `process.env.TWILIO_AUTH_TOKEN` here would make that lookup impossible.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TwilioSignatureParams {
  /** The full request URL Twilio invoked, exactly as Twilio built it. */
  url: string;
  /** The parsed POST body params (form-encoded). Empty object for GET. */
  params: Record<string, string>;
  /** The `X-Twilio-Signature` header value from the request. */
  signature: string | undefined;
  /** The Twilio auth token to verify against — per-account, passed in. */
  authToken: string;
}

/**
 * Computes the expected Twilio signature for a request, per Twilio's
 * documented algorithm: HMAC-SHA1 over the URL with sorted POST params
 * appended key+value, base64-encoded.
 */
export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/**
 * Verifies an inbound Twilio request's `X-Twilio-Signature` header against
 * an ALREADY-PARSED params map.
 *
 * This is a low-level building block, not the handler-facing entry point.
 * It is kept exported for the algorithm-level test suite (known-answer
 * vector, tamper detection, param-order independence), but a request
 * handler must NEVER call it directly with a params map it parsed itself —
 * that is exactly the contract flaw closed by `verifyAndParseTwilioRequest`
 * below, which owns the one-and-only parse of the wire body and is what
 * every handler should use instead.
 *
 * Returns false (never throws) on a missing header, a missing/empty auth
 * token, a tampered URL, a tampered param, or a wrong token — every failure
 * mode collapses to "reject", which is the only safe default for a public
 * webhook that gates client data.
 */
export function verifyTwilioSignature({
  url,
  params,
  signature,
  authToken,
}: TwilioSignatureParams): boolean {
  if (!signature || !authToken) return false;

  const expected = computeTwilioSignature(url, params, authToken);

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'base64');
    actualBuf = Buffer.from(signature, 'base64');
  } catch {
    // Not expected to throw in practice, but a hostile signature header is
    // caller-controlled input; treat any failure to decode it as "not a
    // match" rather than let it escape as an unhandled exception.
    return false;
  }

  // timingSafeEqual throws on length mismatch, and a forged/truncated
  // signature will very often be a different length — that is not an error
  // condition here, it is simply "not a match".
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Parses an `application/x-www-form-urlencoded` body into a flat map.
 * LAST-wins on a duplicate key, matching Twilio's own POST param semantics
 * (and the signature computation above, which iterates `Object.keys`, so
 * a duplicate key can only ever contribute its final value once, same as
 * this parse). Not exported: the parse and the verification must always
 * happen together, inside `verifyAndParseTwilioRequest` — see that
 * function's doc comment for why a second, independent parse of the same
 * body is the exact bug this module exists to prevent.
 */
function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawVal = idx === -1 ? '' : pair.slice(idx + 1);
    params[decodeURIComponent(rawKey.replace(/\+/g, ' '))] =
      decodeURIComponent(rawVal.replace(/\+/g, ' '));
  }
  return params;
}

export interface TwilioRequestInput {
  /** The full request URL Twilio invoked, exactly as Twilio built it. */
  url: string;
  /** The raw request body, still base64-encoded if `isBase64Encoded`. */
  body: string | undefined;
  /** Whether `body` is base64-encoded, as API Gateway/Lambda URLs report it. */
  isBase64Encoded: boolean | undefined;
  /** The `X-Twilio-Signature` header value from the request. */
  signature: string | undefined;
  /** The Twilio auth token to verify against — per-account, passed in. */
  authToken: string;
}

export interface TwilioVerifiedRequest {
  valid: boolean;
  /**
   * The form params, parsed exactly once, from exactly the body that was
   * signature-checked. There is no second, independent parse anywhere that
   * could disagree with this one.
   */
  params: Record<string, string>;
}

/**
 * The single entry point a handler should use for an inbound Twilio
 * request: it owns BOTH the base64/body decode + form parse AND the
 * signature check, so a handler can never end up holding a different view
 * of the body than the one the signature actually covers.
 *
 * Closes a contract flaw found in adversarial review of this module: an
 * earlier shape took a caller-supplied `params` map, so the signature
 * bound whatever parse the CALLER happened to do — not necessarily the
 * parse the caller went on to read from. Concretely, a body of
 *   `Body=EVIL&From=%2B19998887777&Body=hello&From=%2B15551234567`
 * verifies correctly under a last-wins parse (Twilio's own semantics, and
 * what `parseFormBody` above does) while `URLSearchParams.get()` — the
 * natural thing to reach for — is first-wins and would yield `EVIL` and
 * the spoofed `+19998887777`. An attacker who captures ONE genuinely
 * signed Twilio request can prepend duplicate keys, pass verification, and
 * have forged values land wherever a handler's own separate parse reads
 * from. By parsing exactly once, here, and handing back the very params
 * that were verified, a handler is structurally unable to reintroduce that
 * divergence.
 *
 * `valid` is false (never throws) on any missing signature, missing auth
 * token, tampered URL, tampered param, or wrong token. When `valid` is
 * false, `params` reflects the same single parse but MUST NOT be trusted
 * or acted on — always check `valid` first.
 */
export function verifyAndParseTwilioRequest({
  url,
  body,
  isBase64Encoded,
  signature,
  authToken,
}: TwilioRequestInput): TwilioVerifiedRequest {
  const rawBody = isBase64Encoded && body
    ? Buffer.from(body, 'base64').toString('utf8')
    : (body ?? '');
  const params = rawBody ? parseFormBody(rawBody) : {};

  const valid = verifyTwilioSignature({ url, params, signature, authToken });

  return { valid, params };
}
