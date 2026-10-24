// T-347 — the split-token credential primitives for the GOAT lead-ingest
// webhook. Pure functions only: no AWS SDK, no network, no DB. This is the
// ONE place the credential's format and its compare logic live — the
// 403-ladder handler (T-350) and the minting CLI (T-356) both import this
// module rather than rebuilding any of it inline.
//
// Shape: a credential is `selector.secret`.
//   - `selector` is a non-secret lookup key. It is how the handler finds the
//     stored row (e.g. by a GSI on selector) WITHOUT ever hashing or
//     comparing anything first. Looking up by selector, then verifying only
//     the secret, is what keeps the verify step itself from leaking via
//     timing whether a selector exists — see `verifySecret` below.
//   - `secret` is the actual credential material. Only its SHA-256 hash is
//     ever stored; the plaintext exists at mint time and in the webhook
//     caller's config, nowhere else.
//
// Selector: 16 base32 chars (RFC 4648 alphabet, A-Z2-7, no padding),
// generated from 10 CSPRNG bytes (10 bytes * 8 bits / 5 bits-per-char = 16
// chars exactly — no truncation, no padding char to strip).
//
// Secret: 32 CSPRNG bytes, base64url-encoded (43 chars, no `=` padding —
// base64url drops it and a 32-byte input needs exactly one padding char in
// standard base64, so stripping it is deterministic, not lossy).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SELECTOR_BYTES = 10;
const SELECTOR_CHARS = 16;
const SECRET_BYTES = 32;

// RFC 4648 base32 alphabet. Uppercase only, so a selector round-trips
// case-sensitively without a normalization step anywhere that consumes it.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 32 random bytes, base64url, no padding: 43 chars from the base64url
// alphabet (A-Z a-z 0-9 - _).
const CREDENTIAL_RE = /^([A-Z2-7]{16})\.([A-Za-z0-9_-]{43})$/;

const HASH_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * T-386 — the ONE canonical value of an `IngestKey` row's `purpose` field for
 * a key that is allowed to authorize a lead-ingest write.
 *
 * It lives in THIS module, not in ingest-key-service.ts, because both sides
 * of the comparison have to import it and this is the only module both sides
 * already depend on: the 403-ladder handler imports `parseCredential` /
 * `verifySecret` from here and is deliberately free of the DynamoDB document
 * client that ingest-key-service.ts pulls in, while the mint path (the
 * service, and tools/mint-ingest-key.mjs through it) imports the token
 * primitives from here as well.
 *
 * Why a constant rather than two literals that happen to agree: the mint
 * default read 'lead-vendor' while rung 8 demanded 'lead-ingest', so every
 * key the CLI minted was rejected on every POST with a deliberately
 * cause-free 403 — and both halves' tests passed, because each asserted its
 * own literal. The divergence lived strictly BETWEEN the suites. Any future
 * purpose must be added as another exported constant here, never as an inline
 * string at either the mint site or the guard.
 */
export const INGEST_PURPOSE_LEAD_INGEST = 'lead-ingest';

/**
 * A fixed, constant dummy digest — NOT derived from any real secret or
 * selector — used as the comparison target on a miss (see `verifySecret`).
 * Its only job is to give `timingSafeEqual` a 32-byte buffer to compare
 * against when there is no real stored hash to compare against, so a
 * missing row takes exactly the same code shape (compute digest, call
 * timingSafeEqual, return its result) as a present one. It must never be
 * treated as a valid hash of anything.
 */
const DUMMY_DIGEST = createHash('sha256').update('ingest-token:dummy-miss-comparand').digest();

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Generates a new, non-secret selector: 16 base32 chars from 10 CSPRNG
 * bytes. This is the lookup key for a stored credential row — it is never
 * hashed, it is looked up directly, so the verify step only ever has to
 * compare the secret.
 */
export function generateSelector(): string {
  return base32Encode(randomBytes(SELECTOR_BYTES));
}

/**
 * Generates a new secret: 32 CSPRNG bytes, base64url-encoded (43 chars, no
 * padding). This is the credential material — only its hash is ever
 * persisted.
 */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Hashes a secret with plain SHA-256, hex-encoded.
 *
 * Plain SHA-256 — no salt, no pepper, no work factor (bcrypt/scrypt/argon2)
 * — is the CORRECT choice here, deliberately, and must stay that way:
 *
 *   A slow, salted KDF exists to defend against an attacker who can guess
 *   the input (a human password has maybe 20-40 bits of real entropy, so a
 *   fast hash lets an offline attacker brute-force it). This input is not a
 *   password. It is 256 bits of CSPRNG output from `generateSecret()` above
 *   — there is no dictionary to run, no human-chosen pattern to exploit, and
 *   a work factor would not change the attacker's odds of guessing it
 *   (astronomically zero either way). All a work factor would add here is a
 *   NEW failure mode: the webhook is latency-sensitive (GOAT lead delivery),
 *   and a slow KDF turns every legitimate request into a deliberately-
 *   slowed hash computation for no security benefit.
 *
 *   A server-side pepper is the same mistake in a different shape: it adds
 *   an Amplify `secret()` dependency to a module that exists specifically to
 *   be pure and DB/network-free, and it buys nothing against an attacker who
 *   cannot guess the 256-bit input in the first place. Do not add one (F4).
 *   If a future ticket asks for a pepper here, flag it and refuse — the
 *   right lever against a leaked credential is rotation (selector + secret
 *   are both regenerated), not a secret ingredient bolted onto a hash that
 *   was never the weak point.
 *
 * Returns a 64-char lowercase hex string (the standard `hex` digest
 * encoding of 32 bytes) — picked over base64 so stored hashes are
 * trivially diffable/greppable in logs or a table scan without a decode
 * step, which matters more here than the few bytes base64 would save.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export interface ParsedCredential {
  selector: string;
  secret: string;
}

/**
 * Parses a `selector.secret` credential out of a header value or path
 * segment. Returns `null` on ANY shape deviation — wrong selector length or
 * charset, wrong secret length or charset, missing dot, extra dots, extra
 * characters before/after. This strict rejection (not a loose split-on-dot)
 * is rung 3 of the 403 ladder: a malformed credential is rejected before any
 * lookup or hash is even attempted, so the ladder's later, slower rungs
 * never see garbage input.
 */
export function parseCredential(value: string | null | undefined): ParsedCredential | null {
  if (typeof value !== 'string') return null;
  const match = CREDENTIAL_RE.exec(value);
  if (!match) return null;
  return { selector: match[1], secret: match[2] };
}

function hashHexToDigestBuffer(hex: string | undefined): Buffer {
  if (typeof hex !== 'string' || !HASH_HEX_RE.test(hex)) {
    // Malformed or absent stored hash: fall back to the fixed dummy digest
    // rather than letting `Buffer.from(hex, 'hex')` produce a buffer of an
    // unpredictable (and possibly non-32-byte) length, which would make
    // `timingSafeEqual` throw on a length mismatch instead of returning a
    // clean false. Every path through this function hands back a 32-byte
    // buffer, so the caller's `timingSafeEqual` call always has the same
    // shape no matter what was stored.
    return DUMMY_DIGEST;
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Verifies a candidate secret against a stored hash (and, within a
 * rotation window, an optional previous hash) using
 * `crypto.timingSafeEqual`.
 *
 * This is rung 6 of the 403 ladder and the "not an existence oracle"
 * requirement: a caller must not be able to tell, from response timing,
 * whether `storedHash` is a real stored hash or the row did not exist at
 * all. To hold that property, this function ALWAYS:
 *   1. computes the candidate's SHA-256 digest,
 *   2. resolves a 32-byte comparand for `storedHash` — the real digest if
 *      it looks like one, or the fixed `DUMMY_DIGEST` if `storedHash` is
 *      missing or malformed,
 *   3. calls `timingSafeEqual` against that comparand,
 * regardless of whether step 2 found a real hash or not. The code shape —
 * same number of hash computations, same number of `timingSafeEqual`
 * calls, same buffer lengths — is identical on a hit and a miss. Only the
 * CONTENT compared differs, which `timingSafeEqual` is specifically built
 * not to leak through timing.
 *
 * `previousHash`, when provided, is checked the same way and accepted as a
 * match — this is the secret-rotation grace window: a caller presenting the
 * secret issued before the most recent rotation still authenticates until
 * the window's caller (not this function) stops passing `previousHash` in.
 * This function holds no notion of "after the window" itself; the caller
 * controls that by whether it passes `previousHash` at all.
 */
export function verifySecret(
  candidateSecret: string,
  storedHash: string | undefined,
  previousHash?: string,
): boolean {
  const candidateDigest = createHash('sha256').update(candidateSecret, 'utf8').digest();

  const storedComparand = hashHexToDigestBuffer(storedHash);
  const matchesStored = timingSafeEqual(candidateDigest, storedComparand);

  // The previous-hash check runs unconditionally too, on the same fixed-
  // length-buffer shape, whenever a previousHash was handed in — a caller
  // mid-rotation-window always does the same two-digest shape of work as
  // one past it, never a visibly different amount.
  const previousComparand = hashHexToDigestBuffer(previousHash);
  const matchesPrevious = previousHash !== undefined && timingSafeEqual(candidateDigest, previousComparand);

  return matchesStored || matchesPrevious;
}
