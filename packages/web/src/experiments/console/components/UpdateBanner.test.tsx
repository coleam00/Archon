import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';

test(
  'browser click dismisses, persists across remounts, and permits a newer release',
  async () => {
    const browser = [
      Bun.which('google-chrome'),
      Bun.which('chromium'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    ].find(path => path !== null && Bun.file(path).size > 0);
    if (!browser) throw new Error('Chrome or Chromium is required for the banner interaction test');
    const profile = mkdtempSync(join(tmpdir(), 'archon-update-banner-'));
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'UpdateBanner.browser.tsx')],
      target: 'browser',
      define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env': '{}' },
    });
    expect(build.success).toBe(true);
    const script = await build.outputs[0].text();
    let complete!: (result: string) => void;
    const result = new Promise<string>(resolve => {
      complete = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/result') {
          complete(await request.text());
          return new Response('ok');
        }
        if (path === '/test.js')
          return new Response(script, {
            headers: { 'Content-Type': 'text/javascript' },
          });
        return new Response(
          `<!doctype html><html><body><script>
          window.addEventListener('error', event => {
            void fetch('/result', { method: 'POST', body: event.message });
          });
          window.addEventListener('unhandledrejection', event => {
            void fetch('/result', { method: 'POST', body: String(event.reason) });
          });
        </script><script src="/test.js"></script></body></html>`,
          {
            headers: { 'Content-Type': 'text/html' },
          }
        );
      },
    });
    const child = Bun.spawn(
      [
        browser,
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        server.url.href,
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const diagnostics = new Response(child.stderr).text();
    const timeout = setTimeout(() => {
      complete('browser did not report within 10 seconds');
    }, 10000);
    try {
      const outcome = await Promise.race([
        result,
        child.exited.then(code => `browser exited early: ${code}`),
      ]);
      if (outcome !== 'passed') {
        child.kill();
        await child.exited;
        throw new Error(`${outcome}\n${await diagnostics}`);
      }
      expect(outcome).toBe('passed');
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
      await server.stop(true);
      await removeTempTree(profile);
    }
  },
  testTimeout(15000)
);
