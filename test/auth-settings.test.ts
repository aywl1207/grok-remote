import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyAuthFile,
  nginxProxyConf,
  resolveOidcRuntime,
} from '../lib/auth-settings.js';

test('resolveOidcRuntime is off when file disables it', () => {
  const file = emptyAuthFile();
  file.oidc.enabled = false;
  file.oidc.issuer = 'https://auth.example/o/app';
  file.oidc.clientId = 'id';
  file.oidc.clientSecret = 'secret';
  assert.equal(resolveOidcRuntime({
    OIDC_ISSUER: 'https://auth.example/o/app',
    OIDC_CLIENT_ID: 'id',
    OIDC_CLIENT_SECRET: 'secret',
  }, file), null);
});

test('resolveOidcRuntime uses env when file is follow-default', () => {
  const file = emptyAuthFile();
  const got = resolveOidcRuntime({
    OIDC_ISSUER: 'https://auth.example/o/app/',
    OIDC_CLIENT_ID: 'id',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
  }, file);
  assert.ok(got);
  assert.equal(got!.issuer, 'https://auth.example/o/app');
  assert.equal(got!.source, 'env');
});

test('resolveOidcRuntime prefers file fields when enabled', () => {
  const file = emptyAuthFile();
  file.oidc.enabled = true;
  file.oidc.issuer = 'https://file.example/o/x';
  file.oidc.clientId = 'file-id';
  file.oidc.clientSecret = 'file-secret';
  const got = resolveOidcRuntime({
    OIDC_ISSUER: 'https://env.example/o/x',
    OIDC_CLIENT_ID: 'env-id',
    OIDC_CLIENT_SECRET: 'env-secret',
  }, file);
  assert.ok(got);
  assert.equal(got!.issuer, 'https://file.example/o/x');
  assert.equal(got!.clientId, 'file-id');
  assert.equal(got!.source, 'file');
});

test('nginxProxyConf toggles the basic-auth block', () => {
  const on = nginxProxyConf(true);
  const off = nginxProxyConf(false);
  assert.match(on, /auth_basic "Grok Build Remote"/);
  assert.match(on, /auth_basic_user_file/);
  assert.match(off, /auth_basic off;/);
  assert.doesNotMatch(off, /Grok Build Remote/);
});
