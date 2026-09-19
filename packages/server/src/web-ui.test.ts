import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mountWebUi, ASSET_CACHE_CONTROL, DOCUMENT_CACHE_CONTROL } from './web-ui';

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'archon-web-ui-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>archon</title>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'favicon.png'), 'not really a png');
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

async function mounted(): Promise<Hono> {
  const app = new Hono();
  app.get('/api/health', c => c.json({ ok: true }));
  await mountWebUi(app, dist);
  return app;
}

describe('mountWebUi — caching', () => {
  // The bug this exists to prevent: with no directive at all, a browser or CDN
  // invents an expiry for index.html and keeps pointing at a bundle hash that
  // is no longer on disk, so a deploy silently appears not to have happened.
  test('index.html must be revalidated on every load', async () => {
    const res = await (await mounted()).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(DOCUMENT_CACHE_CONTROL);
  });

  test('a deep SPA route gets the same treatment — it is the same document', async () => {
    const res = await (await mounted()).request('/console/p/some-project/chat');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(DOCUMENT_CACHE_CONTROL);
  });

  test('a hashed asset is kept forever, because its name changes when it does', async () => {
    const res = await (await mounted()).request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(ASSET_CACHE_CONTROL);
  });

  // A miss under /assets/ falls through to the SPA fallback, so it is answered
  // with the document — and must be cached like one. Stamping the asset
  // directive here would tell the browser to keep that HTML for a year under a
  // URL that will later serve a real script.
  test('a missing asset keeps the document directive, not the immutable one', async () => {
    const res = await (await mounted()).request('/assets/index-doesnotexist.js');
    expect(res.headers.get('Cache-Control')).toBe(DOCUMENT_CACHE_CONTROL);
    expect(res.headers.get('Cache-Control')).not.toBe(ASSET_CACHE_CONTROL);
  });

  test('the two directives are genuinely opposite, not accidentally equal', () => {
    expect(ASSET_CACHE_CONTROL).not.toBe(DOCUMENT_CACHE_CONTROL);
    expect(ASSET_CACHE_CONTROL).toContain('immutable');
    // `no-cache` means revalidate, not "don't store" — a 304 must still be possible.
    expect(DOCUMENT_CACHE_CONTROL).not.toContain('no-store');
  });
});

describe('mountWebUi — routing', () => {
  test('still serves the built files', async () => {
    const res = await (await mounted()).request('/');
    expect(await res.text()).toContain('<title>archon</title>');
  });

  test('does not swallow routes registered before it', async () => {
    const res = await (await mounted()).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The API answered, so the SPA document directive must not have been applied.
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});
