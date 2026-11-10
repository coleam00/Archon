import { describe, expect, it } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runTypedOutputs, bindTypedOutputs } from '../packages/workflows/src/typed-output-bindings';
import { writeNodeArtifact } from '../packages/workflows/src/artifacts-index';
import { typedOutputs } from '../.archon/workflows/sdlc/.shared/io';
import { caveats, failed, type Reviews } from '../.archon/workflows/sdlc/.shared/report';

/**
 * The SDLC pack's terminal-report module, tested where the pack lives in this
 * repository. The reviews these tests pass in are resolved by the engine's own
 * binding, so the JSON contract the pack consumes cannot drift from the contract
 * the engine delivers without one of these failing.
 */
const track = trackTempRoots();

function artifactsDir(): string {
  const dir = track(join(tmpdir(), `sdlc-report-${Math.random().toString(36).slice(2)}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A review verdict as the engine records it. */
async function review(
  dir: string,
  nodeId: string,
  producedAt: string,
  result: Record<string, unknown>
): Promise<void> {
  await writeNodeArtifact(
    dir,
    { nodeId, outputType: 'review-report', runId: 'run', producedAt },
    JSON.stringify(result)
  );
}

/** This run's reviews as a `{ outputs: review-report }` binding delivers them. */
async function reviews(dir: string): Promise<Reviews> {
  const bound = await bindTypedOutputs(
    'report',
    { reviews: { outputs: 'review-report' } },
    runTypedOutputs(dir, 'run')
  );
  // Through env text, as a script node receives it.
  return typedOutputs(JSON.stringify(bound?.reviews));
}

/** The report as a tail composes it: with the reviews this node bound. */
async function report(dir: string): Promise<string> {
  return caveats(dir, { reviews: await reviews(dir) });
}

describe('discoveries', () => {
  const record = (title: string) => ({
    title,
    claim: `${title} is real`,
    evidence: ['a.ts:1'],
    relation: 'unrelated',
    source_nodes: ['seams'],
  });

  it('adds raw records written after the last review, and never ones it consolidated', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'review-code.json'),
      JSON.stringify([record('Seen by review')])
    );
    utimesSync(join(dir, 'discoveries', 'review-code.json'), 1, 1);
    await review(dir, 'review__publish', '2026-09-10T09:00:00.000Z', {
      discoveries: [record('Stale mock type')],
    });
    writeFileSync(
      join(dir, 'discoveries', 'review-simplify.json'),
      JSON.stringify([record('Found after review')])
    );
    const text = await report(dir);
    expect(text).toContain('- Stale mock type [unrelated]');
    expect(text).toContain('- Found after review [unreviewed]');
    expect(text).not.toContain('Seen by review');
    expect(text).toContain('If you are an agent reading this');
  });

  it('relays every raw record when no review ran', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'plan.json'),
      JSON.stringify([record('Planner found it')])
    );
    expect(await report(dir)).toContain('- Planner found it [unreviewed]');
  });

  it("lists the latest verdict's discoveries with the relay", async () => {
    const dir = artifactsDir();
    await review(dir, 'review__publish', '2026-09-10T09:00:00.000Z', {
      discoveries: [record('Old')],
    });
    await review(dir, 'recheck__publish', '2026-09-10T10:00:00.000Z', {
      discoveries: [record('Flaky timeout')],
    });
    const text = await report(dir);
    expect(text).toContain('- Flaky timeout [unrelated]');
    expect(text).not.toContain('- Old');
    expect(text).toContain('If you are an agent reading this');
  });

  it('says nothing when the final verdict recorded no discoveries', async () => {
    const dir = artifactsDir();
    await review(dir, 'review__publish', '2026-09-10T09:00:00.000Z', {
      discoveries: [],
    });
    expect(await report(dir)).toBe('');
  });
});

describe('failed', () => {
  it('claims no result and still relays the discoveries the run recorded', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'implement.json'),
      JSON.stringify([{ title: 'Guard refuses an empty diff', relation: 'note' }])
    );
    const text = failed(dir, { reviews: [], pullRequests: [], outcomesFile: undefined });
    expect(text.startsWith('Not done:')).toBe(true);
    expect(text).toContain('- Guard refuses an empty diff [unreviewed]');
    expect(text).not.toContain('Ready');
  });
});

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
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'implement.json'),
      JSON.stringify([{ title: 'Guard refuses an empty diff', relation: 'note' }])
    );
    const child = Bun.spawnSync([process.execPath, script], {
      env: {
        ...process.env,
        ARTIFACTS_DIR: dir,
        INPUTS_REVIEWS: '[]',
        INPUTS_PULL_REQUESTS: '[]',
        INPUTS_OUTCOME: outcome,
      },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as Record<string, unknown>;
  }

  it('reports a failed run as not done, with the discoveries it recorded', async () => {
    const report = await run('null');
    expect(report[result]).toBe(false);
    expect(report.reason).toBe('failed');
    expect(String(report.summary)).toStartWith('Not done:');
    expect(String(report.summary)).toContain('- Guard refuses an empty diff [unreviewed]');
  });

  it("relays the outcome node's report unchanged when it ran", async () => {
    expect(await run(JSON.stringify(passed))).toEqual(passed);
  });
});
