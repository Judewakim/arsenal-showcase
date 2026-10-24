// Twilio inbound voice webhook.
//
// Stage 1 (shipped earlier): stub that returns a TwiML <Say> + <Hangup>.
//
// Stage 2 (this commit): verifies the x-twilio-signature header against
// TWILIO_AUTH_TOKEN via amplify/shared/twilio-signature.ts, and rejects an
// unsigned or forged request with 403 before it reaches any TwiML logic.
// This closes finding F-10 and is a BLOCKING dependency for T-143
// (VENDOR_MANAGEMENT.md:155) and for T-138's sms-inbound endpoint, both of
// which call the same helper with a per-subaccount token looked up at
// runtime instead of this single env-var token.
//
// Stage 3 will:
//   - Read AGENT_PHONE_E164 from env and return <Dial><Number>{phone}</Number></Dial>.
//   - Then replace the env-var lookup with a DynamoDB read against AgentPreference.
//
// Stage 4 will:
//   - Branch on routingMode: phone → <Dial><Number>, browser → <Dial><Client>{sub}</Client>.

import { verifyAndParseTwilioRequest } from '../../shared/twilio-signature.ts';

interface ApiGwV2Event {
  requestContext: {
    domainName?: string;
    http: { method: string; sourceIp?: string; path?: string };
  };
  rawPath?: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}

interface ApiGwV2Result {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const REJECTED_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Reject/>
</Response>`;

const STUB_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This number is not yet configured. Please try again later.</Say>
  <Hangup/>
</Response>`;

/**
 * Reconstructs the exact URL Twilio invoked, for signature verification.
 *
 * Prefers `requestContext.domainName` (set by API Gateway/Lambda URLs from
 * the actual invocation, not attacker-controlled) over the `host` header
 * (client-supplied and therefore spoofable), falling back to `host` only
 * when `domainName` is absent. Under the current wiring this changes
 * nothing operationally — a forged `host` still fails signature
 * verification today because the URL Twilio actually signed used the real
 * domain, so this was already fail-closed. This is ordering hygiene, not a
 * live-vulnerability fix.
 *
 * NOTE: if this endpoint is ever put behind a custom domain with a
 * NON-EMPTY API mapping key, `rawPath` will omit that prefix and every
 * Twilio request will 403 on signature verification (the reconstructed URL
 * won't match what Twilio actually signed) — a total, confusing telephony
 * outage. Keep any custom domain mapping key empty, or extend
 * `reconstructUrl` to re-add it.
 */
function reconstructUrl(event: ApiGwV2Event): string {
  const host = event.requestContext.domainName ?? event.headers?.host ?? '';
  const path = event.rawPath ?? event.requestContext.http.path ?? '';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return `https://${host}${path}${query}`;
}

export const handler = async (event: ApiGwV2Event): Promise<ApiGwV2Result> => {
  console.log('voice-incoming invoked',
    'method=', event.requestContext.http.method,
    'sourceIp=', event.requestContext.http.sourceIp);

  const authToken = process.env.TWILIO_AUTH_TOKEN ?? '';
  const signature = event.headers?.['x-twilio-signature'] ?? event.headers?.['X-Twilio-Signature'];

  // The shared helper owns both the body parse and the signature check, so
  // there is exactly one view of the body anywhere in this handler — never
  // parse `event.body` or `rawBody` separately from this call.
  const { valid } = verifyAndParseTwilioRequest({
    url: reconstructUrl(event),
    body: event.body,
    isBase64Encoded: event.isBase64Encoded,
    signature,
    authToken,
  });

  if (!valid) {
    console.warn('voice-incoming: rejected request with invalid or missing x-twilio-signature');
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/xml' },
      body: REJECTED_TWIML,
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml' },
    body: STUB_TWIML,
  };
};
