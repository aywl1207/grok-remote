import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { b64url, pkceChallenge, signPayload, verifyPayload } from '../lib/oidc.js';

test('pkceChallenge is S256 base64url of the verifier', () => {
  const verifier = 'abc';
  const expect = b64url(crypto.createHash('sha256').update(verifier).digest());
  assert.equal(pkceChallenge(verifier), expect);
  assert.ok(!pkceChallenge(verifier).includes('+'));
  assert.ok(!pkceChallenge(verifier).includes('/'));
});

test('signPayload / verifyPayload round-trip and reject tampering', () => {
  const secret = crypto.randomBytes(32);
  const tok = signPayload(secret, { email: 'a@b.c' }, 60);
  assert.deepEqual(verifyPayload(secret, tok), { email: 'a@b.c' });
  assert.equal(verifyPayload(secret, tok + 'x'), null);
  assert.equal(verifyPayload(crypto.randomBytes(32), tok), null);
});
