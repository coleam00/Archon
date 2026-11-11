import { describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { JsonValue } from '../packages/workflows/src/output-ref';
import type { TypedOutputRecord } from '../packages/workflows/src/schemas/node-bindings';
import type { TypedOutput } from '../.archon/workflows/sdlc/.shared/inputs';
import { scriptApiPreload } from '../.archon/scripts/__tests__/deliver-checks-harness';

/**
 * The SDLC pack's terminal-report module, tested where the pack lives in this
 * repository: a run that failed is never reported as ready or delivered.
 */
const track = trackTempRoots();

function artifactsDir(): string {
  const dir = track(join(tmpdir(), `sdlc-report-${Math.random().toString(36).slice(2)}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The pack restates the engine's typed-output envelope, which it may not import. Each
// side must accept the other's, so a field added, dropped or retyped on either fails here.
const packReadsEngine = (record: TypedOutputRecord): TypedOutput<JsonValue> => record;
const engineReadsPack = (record: TypedOutput<JsonValue>): TypedOutputRecord => ({
  ...record,
  loop: [...record.loop],
});
void packReadsEngine;
void engineReadsPack;

/**
 * Each tail's `report` node, run as the engine runs it: its bindings as env text,
 * with stdout as the node's result.
 */
describe.each([
  {
    tail: 'deliver',
    result: 'ready',
    passed: {
      ready: true,
      reason: 'delivered',
      pr_url: 'https://pr/1',
      ci_rerun: 'none',
      summary: 'Ready.',
    },
  },
  {
    tail: 'build-route',
    result: 'delivered',
    passed: { delivered: true, reason: 'delivered', pr_url: 'https://pr/1', summary: 'Ready.' },
  },
])('$tail report node', ({ tail, result, passed }) => {
  const script = join(import.meta.dir, '..', '.archon/workflows/sdlc', tail, 'scripts/report.ts');

  async function run(outcome: string): Promise<Record<string, unknown>> {
    const dir = artifactsDir();
    const child = Bun.spawnSync([process.execPath, '--preload', scriptApiPreload(), script], {
      env: {
        ...process.env,
        ARTIFACTS_DIR: dir,
        INPUTS_PULL_REQUESTS: '[]',
        INPUTS_OUTCOME: outcome,
      },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as Record<string, unknown>;
  }

  it('reports a failed run as not done', async () => {
    const report = await run('null');
    expect(report[result]).toBe(false);
    expect(report.reason).toBe('failed');
  });

  it("relays the outcome node's report unchanged when it ran", async () => {
    expect(await run(JSON.stringify(passed))).toEqual(passed);
  });
});
