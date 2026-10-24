// ════════════════════════════════════════════════════════════════════════════
// Did the Amplify secret actually resolve?
//
// WHY THIS EXISTS. Amplify Gen 2's `secret('X')` does not put the secret in the
// function's environment at deploy time. It puts the literal string
//
//     <value will be resolved during runtime>
//
// there, and swaps it for the real value at COLD START by reading SSM at the
// path recorded in AMPLIFY_SSM_ENV_CONFIG. When that parameter does not exist,
// nothing fails and nothing warns: the deploy is green, the function boots, and
// `process.env.X` is still that sentence. Whatever the code does next hands the
// sentence to a third party as a credential.
//
// That is not hypothetical. On 2026-09-22 a user could not connect Calendly.
// CALENDLY_CLIENT_SECRET had been written to /amplify/<app>/main/… while the
// function reads /amplify/<app>/main-branch-<hash>/…, so the Lambda sent
// Calendly the placeholder as its client_secret. Calendly failed client
// authentication, fell back to public-client rules, and replied
//
//     Missing required parameter: code_verifier.
//
// — a complaint about PKCE, pointing at a part of the flow that was not broken.
// The frontend then mistook the word "token" in "Calendly token exchange
// failed" for an auth failure and signed her out. Hours of the failure pointed
// everywhere except at the missing parameter.
//
// Stripe hit the same trap on 2026-09-14 and Google was sitting in it unnoticed.
// So: check the value where it is USED, and say the true thing instead of
// letting a third party guess at it.
//
// See also tools/check-secrets.mjs, which catches this from outside before a
// user does, and tools/fix-amplify-secret-paths.mjs, which repairs it.
// ════════════════════════════════════════════════════════════════════════════

// The exact sentinel Amplify substitutes. Matched loosely on the leading
// "<value" because the wording has changed between Amplify versions ("at
// runtime" vs "during runtime") and the check must not depend on the tail.
const PLACEHOLDER = /^<value will be resolved/i;

export function isUnresolvedSecret(value: string | undefined | null): boolean {
  return !value || PLACEHOLDER.test(value);
}

// Throws unless `value` is a real, resolved secret. Call this at the point of
// USE rather than at module scope: a handler whose other operations do not need
// the secret (status, disconnect) should keep working, and a module-scope throw
// turns one missing parameter into a totally dead function.
//
// The message names the environment variable and what to do, because the person
// reading it in CloudWatch is the person who has to fix it.
export function requireSecret(name: string, value: string | undefined | null): string {
  if (!value) {
    throw new Error(
      `${name} is not set for this environment. ` +
      `Run: node tools/check-secrets.mjs`
    );
  }
  if (PLACEHOLDER.test(value)) {
    throw new Error(
      `${name} was never resolved — the function is holding Amplify's placeholder, ` +
      `which means the SSM parameter it reads does not exist. ` +
      `Run: node tools/check-secrets.mjs (repair with tools/fix-amplify-secret-paths.mjs)`
    );
  }
  return value;
}
