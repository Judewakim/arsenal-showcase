// Twilio request-signature verification (F-10). See
// amplify/shared/twilio-signature.ts for the algorithm.

import { suite, check, eq } from './lib/assert.mjs';
import {
  computeTwilioSignature,
  verifyTwilioSignature,
  verifyAndParseTwilioRequest,
} from '../amplify/shared/twilio-signature.ts';
import { handler as voiceIncomingHandler } from '../amplify/functions/voice-incoming/handler.ts';

export default async function run() {
  suite('twilio-signature: known-answer vector (Twilio-published)');

  // Twilio's own documented example, from
  // https://www.twilio.com/docs/usage/security#validating-requests. This is
  // a FIXED expected string, not something this suite computed itself — if
  // the algorithm is wrong (wrong hash, wrong sort direction, wrong
  // concatenation), this is the check that can actually catch it, unlike
  // every other check in this file which verifies its own output.
  const kaUrl = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const kaToken = '12345';
  const kaParams = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  };
  const kaExpected = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

  eq('known-answer vector matches Twilio\'s published example byte-for-byte',
    computeTwilioSignature(kaUrl, kaParams, kaToken), kaExpected);
  check('known-answer vector verifies as valid',
    verifyTwilioSignature({ url: kaUrl, params: kaParams, signature: kaExpected, authToken: kaToken }) === true);

  suite('twilio-signature: verifyTwilioSignature');

  const url = 'https://example.execute-api.us-east-1.amazonaws.com/voice-incoming';
  const params = { CallSid: 'CA123', From: '+15551234567', To: '+15557654321' };
  const authToken = 'test-auth-token';
  const signature = computeTwilioSignature(url, params, authToken);

  check('valid signature is accepted', verifyTwilioSignature({ url, params, signature, authToken }) === true);

  const tampered = { ...params, From: '+19998887777' };
  check('tampered param is rejected', verifyTwilioSignature({ url, params: tampered, signature, authToken }) === false);

  const tamperedUrl = url + '?evil=1';
  check('tampered URL is rejected', verifyTwilioSignature({ url: tamperedUrl, params, signature, authToken }) === false);

  check('missing header is rejected', verifyTwilioSignature({ url, params, signature: undefined, authToken }) === false);

  check('empty header is rejected', verifyTwilioSignature({ url, params, signature: '', authToken }) === false);

  check('wrong token is rejected', verifyTwilioSignature({ url, params, signature, authToken: 'wrong-token' }) === false);

  check('missing auth token is rejected, never treated as a match', verifyTwilioSignature({ url, params, signature, authToken: '' }) === false);

  const getSig = computeTwilioSignature(url, {}, authToken);
  check('GET request with no params still verifies correctly', verifyTwilioSignature({ url, params: {}, signature: getSig, authToken }) === true);

  const a = computeTwilioSignature(url, { b: '2', a: '1' }, authToken);
  const b = computeTwilioSignature(url, { a: '1', b: '2' }, authToken);
  eq('param order does not matter — signature is computed over sorted keys', a, b);

  suite('twilio-signature: verifyAndParseTwilioRequest (one parse, not two)');

  // Concrete divergence from the adversarial review of T-136: a body with
  // duplicate keys verifies correctly under a last-wins parse (Twilio's own
  // semantics), while URLSearchParams.get() is first-wins and would read
  // the forged, prepended values instead. The shared helper must own the
  // parse so a handler cannot end up seeing the first-wins view.
  const dupBody = 'Body=EVIL&From=%2B19998887777&Body=hello&From=%2B15551234567';
  const dupUrl = 'https://example.execute-api.us-east-1.amazonaws.com/sms-inbound';
  const dupAuthToken = 'dup-test-token';

  const lastWinsParams = { Body: 'hello', From: '+15551234567' };
  const dupSignature = computeTwilioSignature(dupUrl, lastWinsParams, dupAuthToken);

  const result = verifyAndParseTwilioRequest({
    url: dupUrl,
    body: dupBody,
    isBase64Encoded: false,
    signature: dupSignature,
    authToken: dupAuthToken,
  });

  check('duplicate-key body verifies against the last-wins signature', result.valid === true);
  eq('duplicate-key body returns the last-wins Body, not the spoofed first value', result.params.Body, 'hello');
  eq('duplicate-key body returns the last-wins From, not the spoofed number', result.params.From, '+15551234567');

  // Sanity: URLSearchParams really is first-wins, confirming the divergence
  // this helper exists to close (not asserting anything about the helper
  // itself — this documents why a handler must never reach for
  // URLSearchParams on a Twilio body).
  const firstWinsCheck = new URLSearchParams(dupBody);
  eq('sanity check: URLSearchParams is first-wins (the bug this closes)', firstWinsCheck.get('Body'), 'EVIL');

  const base64Body = Buffer.from(dupBody, 'utf8').toString('base64');
  const base64Result = verifyAndParseTwilioRequest({
    url: dupUrl,
    body: base64Body,
    isBase64Encoded: true,
    signature: dupSignature,
    authToken: dupAuthToken,
  });
  check('base64-encoded body still verifies and parses correctly', base64Result.valid === true);
  eq('base64-encoded body returns the last-wins Body', base64Result.params.Body, 'hello');

  const forgedResult = verifyAndParseTwilioRequest({
    url: dupUrl,
    body: dupBody,
    isBase64Encoded: false,
    signature: computeTwilioSignature(dupUrl, { Body: 'EVIL', From: '+19998887777' }, dupAuthToken),
    authToken: dupAuthToken,
  });
  check('a signature computed over the first-wins (forged) params does not verify', forgedResult.valid === false);

  suite('voice-incoming handler: signature gate');

  const hAuthToken = 'handler-test-token';
  const priorEnv = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = hAuthToken;

  function baseEvent(overrides = {}) {
    return {
      requestContext: {
        domainName: 'example.execute-api.us-east-1.amazonaws.com',
        http: { method: 'POST', sourceIp: '1.2.3.4', path: '/voice-incoming' },
      },
      rawPath: '/voice-incoming',
      rawQueryString: '',
      body: 'CallSid=CA1&From=%2B15551234567',
      isBase64Encoded: false,
      headers: {},
      ...overrides,
    };
  }

  function hUrl() {
    return 'https://example.execute-api.us-east-1.amazonaws.com/voice-incoming';
  }

  {
    // 403 + <Reject/> on a missing signature.
    const noSigRes = await voiceIncomingHandler(baseEvent());
    check('missing signature: handler returns 403', noSigRes.statusCode === 403);
    check('missing signature: handler returns <Reject/> TwiML', noSigRes.body.includes('<Reject'));

    // 403 on a forged (non-base64-decodable garbage) signature — must not throw.
    let forgedThrew = false;
    let forgedRes;
    try {
      forgedRes = await voiceIncomingHandler(baseEvent({
        headers: { 'x-twilio-signature': 'not-valid-base64-!!!@@@' },
      }));
    } catch {
      forgedThrew = true;
    }
    check('attacker-supplied non-base64 signature does not throw', forgedThrew === false);
    check('attacker-supplied non-base64 signature results in 403', forgedRes && forgedRes.statusCode === 403);

    // Valid signature over the plain (non-base64) body -> 200.
    const plainParams = { CallSid: 'CA1', From: '+15551234567' };
    const plainSig = computeTwilioSignature(hUrl(), plainParams, hAuthToken);
    const okRes = await voiceIncomingHandler(baseEvent({
      headers: { 'x-twilio-signature': plainSig },
    }));
    check('valid signature over plain body: handler returns 200', okRes.statusCode === 200);

    // Valid signature over a base64-encoded body -> 200 (same params, same signature,
    // since the signature is computed over the decoded form params either way).
    const b64Body = Buffer.from('CallSid=CA1&From=%2B15551234567', 'utf8').toString('base64');
    const b64Res = await voiceIncomingHandler(baseEvent({
      body: b64Body,
      isBase64Encoded: true,
      headers: { 'x-twilio-signature': plainSig },
    }));
    check('valid signature over base64-encoded body: handler returns 200', b64Res.statusCode === 200);

    // Empty param values still verify.
    const emptyParams = { CallSid: '', From: '' };
    const emptySig = computeTwilioSignature(hUrl(), emptyParams, hAuthToken);
    const emptyRes = await voiceIncomingHandler(baseEvent({
      body: 'CallSid=&From=',
      headers: { 'x-twilio-signature': emptySig },
    }));
    check('empty param values still verify and return 200', emptyRes.statusCode === 200);

    // Unicode param values still verify.
    const unicodeRaw = 'Caller=%E2%98%8E%20Jos%C3%A9';
    const unicodeParams = { Caller: '☎ José' };
    const unicodeSig = computeTwilioSignature(hUrl(), unicodeParams, hAuthToken);
    const unicodeRes = await voiceIncomingHandler(baseEvent({
      body: unicodeRaw,
      headers: { 'x-twilio-signature': unicodeSig },
    }));
    check('unicode param values still verify and return 200', unicodeRes.statusCode === 200);
  }

  process.env.TWILIO_AUTH_TOKEN = priorEnv;
}
