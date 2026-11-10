/** Cache-Control for grok-remote static files. HTML/SW must never be cached. */
export function staticCacheControl(rel: string): string {
  const path = rel.startsWith('/') ? rel : `/${rel}`;
  if (
    path === '/index.html' ||
    path === '/' ||
    path === '/sw.js' ||
    path.endsWith('.webmanifest') ||
    path === '/manifest.webmanifest'
  ) {
    return 'no-store, no-cache, must-revalidate';
  }
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}
