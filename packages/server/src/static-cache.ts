import type { Env, Hono, Schema } from 'hono';
import { serveStatic } from 'hono/bun';

/**
 * Serve the built web UI with the Cache-Control policy of a hashed-asset SPA
 * (#3383).
 *
 * The two halves want opposite answers:
 *
 * - `/assets/*` filenames carry a content hash, so the bytes behind a name
 *   never change. Safe to keep indefinitely and never revalidate.
 * - `index.html` names those hashes, so a stale copy pins the browser to a
 *   bundle hash that is no longer on disk. It must be revalidated on every
 *   load, which `no-cache` permits while still allowing a 304.
 *
 * Without these headers, browsers and CDNs fall back to heuristic caching and
 * invent their own expiry, so a deploy can silently appear not to have happened.
 *
 * Each route sets the policy for what it serves. Classifying the resolved file
 * path instead is wrong: `webDistPath` is absolute, so an install under a
 * directory named `assets` would make `index.html` immutable.
 */

/** `Cache-Control` value for content-hashed assets: cache forever, never revalidate. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `Cache-Control` value for the SPA entry point: revalidate on every load. */
export const HTML_CACHE_CONTROL = 'no-cache';

/**
 * Register the web UI routes on `app`. The `*` SPA fallback must be registered
 * after every API route, so call this last.
 */
export function serveWebUi<E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  webDistPath: string
): void {
  app.use(
    '/assets/*',
    serveStatic({
      root: webDistPath,
      onFound: (_path, c) => {
        c.header('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
      },
    })
  );
  app.use('/favicon.png', serveStatic({ root: webDistPath, path: 'favicon.png' }));
  app.get(
    '*',
    serveStatic({
      root: webDistPath,
      path: 'index.html',
      onFound: (_path, c) => {
        c.header('Cache-Control', HTML_CACHE_CONTROL);
      },
    })
  );
}
