import test from 'node:test';
import assert from 'node:assert/strict';
import { staticCacheControl } from '../lib/static-cache.js';

test('HTML and service worker are never cached', () => {
  assert.equal(staticCacheControl('/index.html').includes('no-store'), true);
  assert.equal(staticCacheControl('/sw.js').includes('no-store'), true);
  assert.equal(staticCacheControl('/manifest.webmanifest').includes('no-store'), true);
});

test('hashed assets are immutable', () => {
  assert.equal(staticCacheControl('/assets/index-abc.js'), 'public, max-age=31536000, immutable');
});
