import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyPair } from 'near-api-js';
import { checkedKeyPair } from './signer.mjs';

test('accepts a key whose public key matches', () => {
  const kp = KeyPair.fromRandom('ed25519');
  const expected = kp.getPublicKey().toString();
  assert.equal(checkedKeyPair(kp.toString(), expected).getPublicKey().toString(), expected);
});

test('rejects a key whose public key does not match', () => {
  const kp = KeyPair.fromRandom('ed25519');
  assert.throws(() => checkedKeyPair(kp.toString()), /Agent key mismatch/);
});

test('rejects a missing or malformed key without echoing it', () => {
  assert.throws(() => checkedKeyPair(undefined), /not set/);
  assert.throws(() => checkedKeyPair('ed25519:nope-secret'), (e) => !e.message.includes('nope-secret'));
});
