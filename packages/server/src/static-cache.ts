/**
 * Cache-Control policy for the built web UI served by `serveStatic` (#3383).
 *
 * The two halves of a hashed-asset SPA want opposite answers:
 *
 * - `/assets/*` — filenames carry a content hash, so the bytes behind a name
 *   never change. Safe to keep indefinitely and never revalidate.
 * - `index.html` — names those hashes, so a stale copy pins the browser to a
 *   bundle hash that is no longer on disk. Must be revalidated on every load,
 *   which `no-cache` permits while still allowing a 304.
 *
 * This is the standard pairing for a hashed-asset SPA. Without it, browsers and
 * CDNs fall back to heuristic caching and invent their own expiry, so a deploy
 * can silently appear not to have happened.
 *
 * `serveStatic`'s `onFound(path, c)` receives the resolved filesystem path, so
 * the request's query string and any URL prefix are already gone — that is what
 * keeps `/assets/index-a1b2c3.js?v=1` an immutable asset rather than an HTML
 * document.
 */

/** `Cache-Control` value for content-hashed assets: cache forever, never revalidate. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `Cache-Control` value for the SPA entry point: revalidate on every load. */
export const HTML_CACHE_CONTROL = 'no-cache';

/**
 * Decide the `Cache-Control` value for a file `serveStatic` just found.
 *
 * @param resolvedPath Filesystem path of the file being served.
 * @returns The `Cache-Control` value, or `undefined` when no directive applies.
 */
export function cacheControlForStaticPath(resolvedPath: string): string | undefined {
  // `/assets/` first: a hashed HTML file under it is still an immutable asset,
  // and the `.html` test below would otherwise claim it for the entry-point
  // policy and pin the browser to a bundle hash the deploy has replaced.
  if (resolvedPath.includes('/assets/') || resolvedPath.includes('\\assets\\')) {
    return IMMUTABLE_ASSET_CACHE_CONTROL;
  }
  if (resolvedPath.endsWith('.html')) {
    return HTML_CACHE_CONTROL;
  }
  return undefined;
}
