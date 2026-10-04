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
    const requests: string[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path === '/result') {
          complete(await request.text());
          return new Response('ok');
        }
        if (path === '/test.js') {
          // Browser startup uses the runner's platform budget, not the fixture's deadline.
          timeout = setTimeout(() => {
            complete('browser fixture did not report within 10 seconds of script delivery');
          }, 10000);
          return new Response(script, {
            headers: { 'Content-Type': 'text/javascript' },
          });
        }
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
    let diagnostics = '';
    const decoder = new TextDecoder();
    void child.stderr.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk): void {
          diagnostics += decoder.decode(chunk);
        },
      })
    );
    try {
      const outcome = await Promise.race([
        result,
        child.exited.then(code => `browser exited early: ${code}`),
      ]);
      if (outcome !== 'passed') {
        throw new Error(
          `${outcome}\nBrowser: ${browser}\nURL: ${server.url.href}\nRequests: ${requests.join(', ')}\n${diagnostics}`
        );
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
