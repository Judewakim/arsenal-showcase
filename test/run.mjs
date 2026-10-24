// Test harness. Run with `npm test` or `node test/run.mjs`.
// No framework and no build step, matching the production repo this was taken from.
import { report } from './lib/assert.mjs';
import fieldCrypto from './field-crypto.cases.mjs';
import auditChain from './audit-chain.cases.mjs';
import authz from './authz.cases.mjs';
import ingestToken from './ingest-token.cases.mjs';
import twilioSignature from './twilio-signature.cases.mjs';
import logHygiene from './log-hygiene.cases.mjs';

for (const fn of [fieldCrypto, auditChain, authz, ingestToken, twilioSignature, logHygiene]) {
  await fn();
}
process.exit(report());
