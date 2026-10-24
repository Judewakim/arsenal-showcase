// Log hygiene: the sensitive data that never should have been written down.
//
// ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// Two handlers opened with the same defensive line:
//
//   console.error('No fieldName on event:', JSON.stringify(event));
//
// On a secureCreateRecord call, `event.arguments.input` is the client's entire
// unencrypted record — SSN, bank routing and account, card number, CVV, and the
// full medical history. That line takes the exact payload secure-record exists
// to encrypt and writes it in the clear to a CloudWatch log group that has no
// retention limit and no CMK. It lands outside the encryption boundary the
// function was built to enforce. A third handler printed the first 40
// characters of the Slack webhook secret, where the URL path IS the credential.
//
// None of them looked dangerous, because the event-dump branches only fire when
// `fieldName` is missing and AppSync always sets it. That is precisely why they
// survived code review: the disclosure is unreachable right up until it isn't,
// and the blast radius is a reportable HIPAA incident.
//
// The bug class is debug logging that outlived the debugging, and it recurs
// because the fix is invisible — nothing about a passing test suite or a green
// deploy tells you a log line grew a sensitive field. The object being
// serialized gains new columns over time while the log statement never changes.
//
// So this suite is a POLICY LINT rather than a unit test: it reads the shipped
// backend source the way an auditor would and fails the build if a raw dump
// comes back. `.github/workflows/ci.yml` runs `npm test` on every push, so this
// is an actual gate and not a note.
//
// Modelled on deploy-config.cases.mjs, which scans tracked files for conflict
// markers. Same reason for asking git rather than walking the filesystem: it
// respects .gitignore, so node_modules and .amplify never enter the scan, and
// it only sees what a push would actually carry.

import { suite, check, eq } from './lib/assert.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventShape, describeSecret } from '../amplify/shared/log.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));

// Built by concatenation so this file can never trip its own scan while
// describing what it looks for — the same trick deploy-config.cases.mjs uses
// with its conflict markers.
const STRINGIFY = 'JSON.' + 'stringify';

// Each rule is [label, RegExp, why it matters].
//
// The patterns match the OBJECT being logged, not the function doing the
// logging, because the danger is the payload. `JSON.stringify(event)` is fatal;
// `JSON.stringify(stats)` is fine and common in these handlers.
const FORBIDDEN = [
  [
    `${STRINGIFY}(event)`,
    new RegExp(`${STRINGIFY}\\s*\\(\\s*event\\s*\\)`),
    'serializes the whole AppSync event, including arguments.input — the unencrypted record',
  ],
  [
    `${STRINGIFY}(event.arguments)`,
    new RegExp(`${STRINGIFY}\\s*\\(\\s*event\\.arguments`),
    'serializes raw client arguments, which carry PHI on record writes',
  ],
  [
    'console.*(event)',
    /console\.(log|error|warn|info|debug)\s*\(\s*event\s*[,)]/,
    'passes the whole event object to the console; Lambda serializes it the same way',
  ],
  // T-350 — the lead-ingest webhook's four new log-hygiene rules. Its
  // credential rides in the URL PATH or an Authorization header (never a
  // body field a generic "don't log the body" rule would already catch), so
  // each of these needed its own pattern rather than reusing the three above.
  [
    'console.*(request path)',
    /console\.(log|error|warn|info|debug)\s*\([^\n]*\b(rawPath|pathParameters|requestContext\.http\.path)\b/,
    'the lead-ingest credential can ride in the URL path itself (selector.secret) — logging the path is logging the credential',
  ],
  [
    'console.*(credential)',
    /console\.(log|error|warn|info|debug)\s*\([^\n]*\b(selector|secret|credential|[Aa]uthorization)\b/,
    'logs the split-token credential (or a header carrying it) in whole or in part',
  ],
  [
    'console.*(phone number)',
    /console\.(log|error|warn|info|debug)\s*\([^\n]*\b(phone|phoneE164|toE164|fromE164)\b/i,
    'logs a phone number — PII a purchased-lead vendor payload always carries',
  ],
  [
    'console.*(raw body)',
    /console\.(log|error|warn|info|debug)\s*\([^\n]*\bevent\.body\b/,
    'logs the raw, unparsed vendor payload — the exact thing the KMS-envelope archive write exists to protect instead',
  ],
];

// Handlers hold secrets in module constants. Printing any slice of one is the
// same bug as printing the whole thing when the value IS the credential, which
// is true of a Slack Incoming Webhook — its randomised path is the auth.
const SECRET_SLICE = /\b(WEBHOOK|SECRET|TOKEN|CLIENT_SECRET)\b[^\n;]*\.slice\s*\(/;

export default async function run() {

  // ── The helpers cannot leak, by construction ──────────────────────────────
  suite('Log hygiene — eventShape emits shape, never values');
  {
    // The realistic worst case: a secureCreateRecord event carrying a full
    // record. Nothing recognisable from the input may appear in the output.
    const event = {
      arguments: {
        input: {
          ssn: '123-45-6789',
          routing: '021000021',
          account: '9876543210',
          cardNumber: '4111111111111111',
          cardCVV: '737',
          conditions: 'type 2 diabetes, hypertension',
          name: 'Carol Danvers',
        },
      },
      identity: { username: 'agent@example.com', sub: 'abc-123' },
    };

    const shaped = eventShape(event);
    const serialized = JSON.stringify(shaped);

    for (const secret of [
      '123-45-6789', '021000021', '9876543210',
      '4111111111111111', '737', 'diabetes', 'Carol Danvers',
      'agent@example.com', 'abc-123',
    ]) {
      check(`no trace of ${JSON.stringify(secret)} in the shaped output`,
        !serialized.includes(secret),
        `leaked: ${serialized}`);
    }

    // ...while still being useful enough to debug the malformed invocation the
    // log line exists for.
    eq('argKeys names the top-level arguments', JSON.stringify(shaped.argKeys), '["input"]');
    eq('hasIdentity is a boolean, not the identity', shaped.hasIdentity, true);
    eq('fieldName is null when absent', shaped.fieldName, null);

    // Malformed input is the whole reason this branch runs, so it must not be
    // the thing that throws.
    for (const [label, bad] of [
      ['undefined', undefined], ['null', null],
      ['a string', 'nope'], ['no arguments', { identity: {} }],
      ['null arguments', { arguments: null }],
    ]) {
      let threw = false;
      try { eventShape(bad); } catch { threw = true; }
      check(`eventShape survives ${label}`, !threw,
        'the error path must not have its own error path');
    }
  }

  suite('Log hygiene — describeSecret never prints the secret');
  {
    const webhook = 'https://hooks.slack.com/services/' + ['T00000000', 'B00000000', 'X'.repeat(24)].join('/'); // fake, split so secret scanners don't flag it
    const described = describeSecret(webhook);

    check('the secret path never appears',
      !described.includes('XXXXXXXXXXXXXXXXXXXXXXXX') && !described.includes('T00000000'),
      `leaked: ${described}`);
    check('but the scheme is still reported', described.includes('https'), described);
    check('and the length, which separates placeholder from real value',
      described.includes(String(webhook.length)), described);

    eq('empty is called out plainly', describeSecret(''), 'unset/empty');
    eq('unset is called out plainly', describeSecret(undefined), 'unset/empty');
    check('a non-URL value is distinguishable from a URL one',
      describeSecret('<value will be resolved at runtime>').includes('no recognised scheme'),
      'the Amplify placeholder must be tellable apart from a real webhook');
  }

  // ── Nothing in the shipped backend dumps a request object ─────────────────
  suite('Log hygiene — no raw event or secret dumps in amplify/');
  {
    let tracked = [];
    let gitError = null;
    try {
      tracked = execFileSync('git', ['ls-files', '-z', 'amplify'], {
        cwd: REPO,
        maxBuffer: 64 * 1024 * 1024,
      }).toString('utf8').split('\0').filter(Boolean);
    } catch (err) {
      gitError = String(err.message).split('\n')[0];
    }

    const sources = tracked.filter(rel => /\.ts$/.test(rel));

    check('the tracked backend source list was readable',
      gitError === null && sources.length > 0,
      gitError || 'git ls-files returned nothing — the scans below would pass vacuously');

    for (const [label, pattern, why] of FORBIDDEN) {
      const offenders = [];
      for (const rel of sources) {
        let text;
        try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); }
        catch { continue; } // deleted-but-tracked; not this test's problem

        text.split(/\r?\n/).forEach((line, i) => {
          // Skip comments — this codebase explains its own history in prose,
          // and a comment describing the old bug is not the old bug.
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*')) return;
          if (pattern.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
      }

      check(`no handler logs ${label}`, offenders.length === 0,
        offenders.length ? `${why} — found at: ${offenders.join(', ')}` : '');
    }

    const secretOffenders = [];
    for (const rel of sources) {
      let text;
      try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); }
      catch { continue; }

      text.split(/\r?\n/).forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*')) return;
        if (SECRET_SLICE.test(line)) secretOffenders.push(`${rel}:${i + 1}`);
      });
    }

    check('no handler logs a slice of a secret', secretOffenders.length === 0,
      secretOffenders.length
        ? 'a Slack webhook URL is a credential — its path is the auth, so a prefix is '
          + `still a disclosure. Use describeSecret(). Found at: ${secretOffenders.join(', ')}`
        : '');
  }

  // ── Prove the T-350 patterns can actually fail ─────────────────────────────
  // A policy lint that always reports "no offenders" because its regex never
  // matches anything is not a check, it is decoration — exactly the trap
  // this repo's own records warn about (checks that cannot fail). Each new
  // rule gets one fixture it must catch and one near-miss it must not.
  suite('Log hygiene — T-350 patterns catch real offenses and spare safe neighbours');
  {
    const byLabel = Object.fromEntries(FORBIDDEN.map(([label, pattern]) => [label, pattern]));

    const cases = [
      {
        label: 'console.*(request path)',
        shouldMatch: "console.error('lead-ingest', event.rawPath)",
        shouldSpare: "console.error('lead-ingest', JSON.stringify(stats))",
      },
      {
        label: 'console.*(request path)',
        shouldMatch: "console.log('key', event.pathParameters)",
        shouldSpare: "console.log('accepted', ingestKeyId)",
      },
      {
        label: 'console.*(credential)',
        shouldMatch: "console.warn('bad cred', parsed.secret)",
        shouldSpare: "console.log('accepted', verifiedRow.producerId)",
      },
      {
        label: 'console.*(credential)',
        shouldMatch: "console.error('auth failed', headers.Authorization)",
        shouldSpare: "console.error('lead-ingest error', err)",
      },
      {
        label: 'console.*(phone number)',
        shouldMatch: "console.log('lead phone', lead.phoneE164)",
        shouldSpare: "console.log('accepted', bodyBytes)",
      },
      {
        label: 'console.*(raw body)',
        shouldMatch: "console.error('bad payload', event.body)",
        shouldSpare: "console.error('bad payload', bodyByteLength(event))",
      },
    ];

    for (const { label, shouldMatch, shouldSpare } of cases) {
      const pattern = byLabel[label];
      check(`${label} — catches: ${shouldMatch}`, pattern.test(shouldMatch) === true);
      check(`${label} — spares: ${shouldSpare}`, pattern.test(shouldSpare) === false);
    }
  }
}
