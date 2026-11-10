import test from 'node:test';
import assert from 'node:assert/strict';
import { createRafPainter } from '../src/lib/raf-paint.js';

test('createRafPainter coalesces to one paint then flush', async () => {
  const origR = globalThis.requestAnimationFrame;
  const origC = globalThis.cancelAnimationFrame;
  let queued: FrameRequestCallback | null = null;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued = cb;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => { queued = null; }) as typeof cancelAnimationFrame;
  try {
    let n = 0;
    const painter = createRafPainter(() => { n += 1; });
    painter.schedule();
    painter.schedule();
    painter.schedule();
    assert.equal(n, 0);
    queued!(0);
    assert.equal(n, 1);
    queued = null;
    painter.flush();
    assert.equal(n, 2);
  } finally {
    globalThis.requestAnimationFrame = origR;
    globalThis.cancelAnimationFrame = origC;
  }
});
