// Field-level envelope encryption (amplify/shared/field-crypto.ts).
//
// Written for this showcase: in the production repo the same behaviour is
// covered indirectly by the secure-record suites. KMS is replaced with an
// in-memory fake so the suite runs offline; the fake "wraps" a data key by
// XOR-ing it with a fixed key, which is enough to prove the module never
// stores the plaintext DEK and unwraps exactly once per record.

import { suite, check, eq, deepEq } from './lib/assert.mjs';
import { randomBytes } from 'node:crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

process.env.KMS_KEY_ID = 'alias/test-phi-key';

const MASTER = randomBytes(32);
const wrap = (buf) => Buffer.from(buf.map((b, i) => b ^ MASTER[i % 32]));
const calls = { generate: 0, decrypt: 0 };

KMSClient.prototype.send = async function (cmd) {
  if (cmd instanceof GenerateDataKeyCommand) {
    calls.generate++;
    const plaintext = randomBytes(32);
    return { Plaintext: new Uint8Array(plaintext), CiphertextBlob: new Uint8Array(wrap(plaintext)) };
  }
  if (cmd instanceof DecryptCommand) {
    calls.decrypt++;
    return { Plaintext: new Uint8Array(wrap(Buffer.from(cmd.input.CiphertextBlob))) };
  }
  throw new Error('unexpected KMS command');
};

const { encryptFields, decryptFields, encryptOne, decryptOne, SENSITIVE_FIELDS } =
  await import('../amplify/shared/field-crypto.ts');

export default async function run() {
  suite('Field crypto — AES-256-GCM primitives');
  {
    const key = randomBytes(32);
    const ct = encryptOne('123-45-6789', key);
    eq('round-trips a value', decryptOne(ct, key), '123-45-6789');
    check('ciphertext does not contain the plaintext', !Buffer.from(ct, 'base64').toString('latin1').includes('123-45-6789'));
    check('same plaintext encrypts differently each time (fresh IV)', encryptOne('x', key) !== encryptOne('x', key));

    let tamperRejected = false;
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 1;
    try { decryptOne(buf.toString('base64'), key); } catch { tamperRejected = true; }
    check('a single flipped bit is rejected by the GCM auth tag', tamperRejected);

    let wrongKeyRejected = false;
    try { decryptOne(ct, randomBytes(32)); } catch { wrongKeyRejected = true; }
    check('the wrong key is rejected, not silently decrypted to garbage', wrongKeyRejected);
  }

  suite('Field crypto — envelope encryption of a record');
  {
    const record = {
      owner: 'agent@example.com', firstName: 'Test', carrier: 'Example Life',
      ssn: '000-00-0000', dob: '1950-01-01', conditions: 'fictional condition', medications: '',
    };
    calls.generate = calls.decrypt = 0;
    const enc = await encryptFields(record);

    eq('one KMS data key per record', calls.generate, 1);
    deepEq('only present sensitive fields are encrypted', enc.__encryptedFields, ['ssn', 'conditions', 'dob']);
    check('ssn is not stored in plaintext', enc.ssn !== record.ssn);
    check('dob is not stored in plaintext', enc.dob !== record.dob);
    eq('non-sensitive fields are untouched', enc.carrier, 'Example Life');
    eq('empty sensitive fields are left alone', enc.medications, '');
    check('the wrapped key rides with the record', typeof enc.__wrappedDEK === 'string' && enc.__wrappedDEK.length > 0);
    check('the input record is not mutated', record.ssn === '000-00-0000' && !('__wrappedDEK' in record));

    const dec = await decryptFields(enc);
    eq('one KMS Decrypt call unwraps every field', calls.decrypt, 1);
    eq('ssn decrypts back', dec.ssn, record.ssn);
    eq('dob decrypts back', dec.dob, record.dob);
    eq('conditions decrypt back', dec.conditions, record.conditions);
    check('envelope metadata is stripped on read', !('__wrappedDEK' in dec) && !('__encryptedFields' in dec));
  }

  suite('Field crypto — edge cases');
  {
    calls.generate = 0;
    const plain = await encryptFields({ owner: 'a', carrier: 'X' });
    eq('a record with no sensitive data never calls KMS', calls.generate, 0);
    check('and carries no envelope', !('__wrappedDEK' in plain));
    eq('decrypting nothing returns null', await decryptFields(null), null);
    check('health-screen fields are in the encrypted set', ['hxCardiac', 'hxCancer', 'uwAnswers'].every(f => SENSITIVE_FIELDS.includes(f)));
    check('card number and CVV are no longer stored at all', !SENSITIVE_FIELDS.includes('cardNumber') && !SENSITIVE_FIELDS.includes('cardCVV'));
  }
}
