import type { Hono, MiddlewareHandler } from 'hono';

/**
 * Just the two registration methods this needs.
 *
 * Structural rather than `Hono`, because the server's app is an `OpenAPIHono`
 * whose generic environment does not unify with a bare `Hono` — and mounting
 * static files has no reason to care which of the two it was handed.
 */
type Mountable = Pick<Hono, 'use'> & {
  get: (path: string, ...handlers: MiddlewareHandler[]) => unknown;
};

/**
 * Cache directives for the built web UI.
 *
 * A hashed-asset SPA needs two opposite answers, and until now it gave neither:
 * nothing set `Cache-Control`, `ETag` or `Last-Modified` on any of it, so
 * browsers and CDNs fell back to heuristic caching and invented their own
 * expiry for `index.html`.
 *
 * That is worse than it sounds. `index.html` is the pointer to the hashed
 * bundle names, so a stale copy pins a browser to a bundle that is no longer on
 * disk — the deploy happened, and the user sees the old app until they think to
 * hard-refresh. A deploy that silently appears not to have happened is hard to
 * tell apart from a deploy that actually failed.
 *
 *   /assets/*   content-hashed: the bytes behind a name never change, so the
 *               file can be kept forever and never revalidated.
 *   index.html  names those hashes, so it must be revalidated on every load or
 *               it outlives the assets it points at.
 *
 * `no-cache` is revalidate-every-time, not do-not-store: a 304 still saves the
 * download when nothing has changed.
 */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DOCUMENT_CACHE_CONTROL = 'no-cache';

/**
 * Mount the built web UI on an app: hashed assets, the favicon, and the SPA
 * fallback, each with the cache directive it needs.
 *
 * Extracted from the server bootstrap so the caching behaviour can be tested by
 * mounting it on a bare app — `startServer` needs a database and the platform
 * adapters, so nothing reachable only through it can be covered.
 *
 * Registers in the same order as before, and must still be mounted after the
 * API routes: the SPA fallback matches everything.
 */
export async function mountWebUi(app: Mountable, webDistPath: string): Promise<void> {
  const { serveStatic } = await import('hono/bun');

  // `onFound` rather than a wrapping middleware: a miss under /assets/ calls
  // next() and falls through to the SPA fallback below, which answers with the
  // document. A wrapper would then stamp the immutable directive over that
  // document's no-cache — telling the browser to keep a piece of HTML, served
  // under an asset URL, for a year. This callback only runs when the file is
  // really there.
  app.use(
    '/assets/*',
    serveStatic({
      root: webDistPath,
      onFound: (_path, c) => {
        c.header('Cache-Control', ASSET_CACHE_CONTROL);
      },
    })
  );

  app.use('/favicon.png', serveStatic({ root: webDistPath, path: 'favicon.png' }));

  // SPA fallback - serve index.html for unmatched routes (after all API routes)
  app.get(
    '*',
    async (c, next) => {
      await next();
      c.header('Cache-Control', DOCUMENT_CACHE_CONTROL);
    },
    serveStatic({ root: webDistPath, path: 'index.html' })
  );
}
