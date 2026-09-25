import { afterAll, describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { HTML_CACHE_CONTROL, IMMUTABLE_ASSET_CACHE_CONTROL, serveWebUi } from './static-cache';

// Each describe reads its tree across several tests, so clean up once at the end.
const tempRoots: string[] = [];
afterAll(async () => {
  for (const root of tempRoots) await removeTempTree(root);
});

/** Build a web dist tree under `parentSegments` and serve it the way the server does. */
function webUiApp(...parentSegments: string[]): Hono {
  const base = mkdtempSync(join(tmpdir(), 'archon-static-cache-'));
  tempRoots.push(base);
  const root = join(base, ...parentSegments, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'index-a1b2c3.js'), 'console.log(1)');
  writeFileSync(join(root, 'index.html'), '<html>app</html>');
  writeFileSync(join(root, 'favicon.png'), 'png');
  const app = new Hono();
  serveWebUi(app, root);
  return app;
}

describe('serveWebUi cache headers', () => {
  const app = webUiApp('web');

  test('a hashed asset is cached forever', async () => {
    const res = await app.request('/assets/index-a1b2c3.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  test('a hashed asset with a query string is still cached forever', async () => {
    const res = await app.request('/assets/index-a1b2c3.js?v=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  test('the SPA entry point is revalidated on every load', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>app</html>');
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
  });

  test('a deep SPA route serves the entry point with no-cache', async () => {
    const res = await app.request('/conversations/abc-123');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
  });

  test('the favicon carries no cache directive', async () => {
    const res = await app.request('/favicon.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});

describe('serveWebUi under a directory named assets', () => {
  // The policy follows the route, not the filesystem path: an install at
  // e.g. /srv/assets/archon/dist must still revalidate index.html.
  const app = webUiApp('assets', 'archon');

  test('the SPA entry point is still revalidated on every load', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
  });

  test('a hashed asset is still cached forever', async () => {
    const res = await app.request('/assets/index-a1b2c3.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });
});
