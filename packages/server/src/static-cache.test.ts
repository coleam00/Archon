import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheControlForStaticPath,
  HTML_CACHE_CONTROL,
  IMMUTABLE_ASSET_CACHE_CONTROL,
} from './static-cache';

describe('cacheControlForStaticPath', () => {
  test('the SPA entry point is revalidated on every load', () => {
    expect(cacheControlForStaticPath('/srv/web/dist/index.html')).toBe(HTML_CACHE_CONTROL);
  });

  test('content-hashed assets are cached forever without revalidation', () => {
    expect(cacheControlForStaticPath('/srv/web/dist/assets/index-a1b2c3.js')).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL
    );
    expect(cacheControlForStaticPath('/srv/web/dist/assets/index-a1b2c3.css')).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL
    );
  });

  test('a query string cannot turn an asset into an HTML document', () => {
    // serveStatic hands onFound the resolved path, so the URL query never
    // reaches this function — assert the decision is made on the path alone.
    expect(cacheControlForStaticPath('/srv/web/dist/assets/index-a1b2c3.js')).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL
    );
  });

  test('a file that merely sits under assets/ is still treated as an asset', () => {
    expect(cacheControlForStaticPath('/srv/web/dist/assets/nested/deep/vendor.js')).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL
    );
  });

  test('an HTML document outside assets/ is still revalidated', () => {
    expect(cacheControlForStaticPath('/srv/web/dist/some/other/page.html')).toBe(
      HTML_CACHE_CONTROL
    );
  });

  test('Windows-style separators are recognized', () => {
    expect(cacheControlForStaticPath('D:\\archon\\web\\dist\\index.html')).toBe(HTML_CACHE_CONTROL);
    expect(cacheControlForStaticPath('D:\\archon\\web\\dist\\assets\\index-a1b2c3.js')).toBe(
      IMMUTABLE_ASSET_CACHE_CONTROL
    );
  });

  test('a file that is neither HTML nor under assets/ gets no directive', () => {
    expect(cacheControlForStaticPath('/srv/web/dist/favicon.png')).toBeUndefined();
    expect(cacheControlForStaticPath('/srv/web/dist/robots.txt')).toBeUndefined();
  });
});

describe('serveStatic cache headers (integration)', () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-static-cache-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'index-a1b2c3.js'), 'console.log(1)');
  writeFileSync(join(root, 'index.html'), '<html>app</html>');
  writeFileSync(join(root, 'favicon.png'), 'png');

  // Mirrors the wiring in packages/server/src/index.ts.
  const app = new Hono();
  app.use(
    '/assets/*',
    serveStatic({
      root,
      onFound: (path, c) => {
        const value = cacheControlForStaticPath(path);
        if (value) c.header('Cache-Control', value);
      },
    })
  );
  app.use('/favicon.png', serveStatic({ root, path: 'favicon.png' }));
  app.get(
    '*',
    serveStatic({
      root,
      path: 'index.html',
      onFound: (path, c) => {
        const value = cacheControlForStaticPath(path);
        if (value) c.header('Cache-Control', value);
      },
    })
  );

  test('a hashed asset response carries the immutable directive', async () => {
    const res = await app.request('/assets/index-a1b2c3.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  test('a hashed asset with a query string is still immutable', async () => {
    const res = await app.request('/assets/index-a1b2c3.js?v=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  test('the SPA entry point is served with no-cache', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>app</html>');
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
  });

  test('a deep SPA route still serves the entry point with no-cache', async () => {
    const res = await app.request('/conversations/abc-123');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL);
  });

  test('the favicon carries no cache directive (neither HTML nor hashed)', async () => {
    const res = await app.request('/favicon.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});
