import test from 'node:test';
import assert from 'node:assert/strict';
import { errorBannerText, shouldClearErrorBanners } from '../src/lib/error-banner.js';

test('empty disconnect payloads do not become Error {}', () => {
  assert.equal(errorBannerText({}), null);
  assert.equal(errorBannerText({ _t: 1, _eventId: 'x' }), null);
  assert.equal(errorBannerText('{}'), null);
  assert.equal(errorBannerText({ message: '' }), null);
  assert.equal(errorBannerText({ message: 'agent exited' }), null);
});

test('real errors still surface', () => {
  assert.equal(errorBannerText({ message: 'hold socket connect failed' }), 'hold socket connect failed');
  assert.equal(errorBannerText('boom'), 'boom');
});

test('error banners clear only on reconnect', () => {
  assert.equal(shouldClearErrorBanners(
    { status: 'disconnected', connected: false },
    { status: 'idle', connected: true },
  ), true);
  assert.equal(shouldClearErrorBanners(
    { status: 'idle', connected: true },
    { status: 'idle', connected: true },
  ), false);
  assert.equal(shouldClearErrorBanners(
    { status: 'running', connected: true },
    { status: 'idle', connected: true },
  ), false);
});
