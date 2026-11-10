/** Coalesce bursty DOM paints to one per animation frame. */

function raf(cb: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}

function caf(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

export function createRafPainter(paint: () => void): {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
} {
  let id = 0;
  const cancel = (): void => {
    if (!id) return;
    caf(id);
    id = 0;
  };
  return {
    schedule(): void {
      if (id) return;
      id = raf(() => {
        id = 0;
        paint();
      });
    },
    flush(): void {
      cancel();
      paint();
    },
    cancel,
  };
}
