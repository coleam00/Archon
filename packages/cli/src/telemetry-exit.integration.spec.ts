import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const tempRoots = trackTempRoots();
function childEnv(host: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARCHON_HOME: tempRoots(mkdtempSync(join(tmpdir(), 'archon-telemetry-exit-'))),
    ARCHON_TELEMETRY_DISABLED: '',
    DO_NOT_TRACK: '',
    CI: '',
    POSTHOG_API_KEY: 'phc_local_test',
    POSTHOG_HOST: host,
    LOG_LEVEL: 'error',
  };
}
async function runChild(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

describe('telemetry exit transport', () => {
  it('counts help, version, and usage errors once on a responsive host, and honors opt-out', async () => {
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const text = new TextDecoder().decode(
          request.headers.get('content-encoding') === 'gzip' ? Bun.gunzipSync(bytes) : bytes
        );
        const payload = JSON.parse(text) as { batch: typeof events };
        events.push(...payload.batch);
        return Response.json({ status: 'ok' });
      },
    });
    try {
      for (const [args, code] of [
        [['--help'], 0],
        [['--version'], 0],
        [['--not-a-valid-flag'], 1],
      ] as const) {
        const before = events.length;
        const result = await runChild(
          [join(import.meta.dir, 'cli.ts'), ...args],
          childEnv(server.url.href)
        );
        expect(result.code).toBe(code);
        expect(events.slice(before)).toMatchObject([
          {
            event: 'archon_started',
            properties: { surface: 'cli', $ip: '', $process_person_profile: false },
          },
        ]);
      }
      const result = await runChild([join(import.meta.dir, 'cli.ts'), '--help'], {
        ...childEnv(server.url.href),
        ARCHON_TELEMETRY_DISABLED: '1',
      });
      expect(result.code).toBe(0);
      expect(events).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  });

  it('cancels stalled ingestion so a child using shutdown can exit naturally', async () => {
    let received = false;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        received = true;
        return Promise.withResolvers<Response>().promise;
      },
    });
    try {
      const telemetryPath = join(import.meta.dir, '../../paths/src/telemetry.ts');
      const source = `import { captureArchonStarted, shutdownTelemetry } from ${JSON.stringify(telemetryPath)};
        captureArchonStarted({ surface: 'cli' });
        const started = performance.now();
        await shutdownTelemetry();
        console.log(JSON.stringify({ shutdownMs: performance.now() - started }));`;
      const started = performance.now();
      const result = await runChild(['-e', source], childEnv(server.url.href));
      expect(result.code).toBe(0);
      expect(received).toBe(true);
      expect(JSON.parse(result.stdout).shutdownMs).toBeLessThan(300);
      // An SDK Promise.race alone leaves its 10-second fetch timer/socket alive.
      expect(performance.now() - started).toBeLessThan(2000);
      expect(result.stderr).toBe('');
    } finally {
      await server.stop(true);
    }
  });
});
