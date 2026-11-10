import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { writeNodeArtifact } from '../packages/workflows/src/artifacts-index';
import { caveats, failed } from '../.archon/workflows/sdlc/.shared/report';

/**
 * The SDLC pack's terminal-report module, tested where the pack lives in this
 * repository. The typed outputs these tests read are written by the engine's own
 * writer and answered by its own `workflow outputs` command, so the JSON contract the
 * pack consumes cannot drift from the contract the engine emits without one of these
 * failing.
 */
const track = trackTempRoots();
const RUN = 'run';

/**
 * The host CLI a pack script reaches, and the run it is. `artifactsDir` adds the Archon
 * home and the output root that CLI answers under.
 */
const hostEnv = {
  ARCHON_CLI_COMMAND: JSON.stringify([
    process.execPath,
    join(import.meta.dir, 'fixtures/sdlc-outputs-cli.ts'),
  ]),
  WORKFLOW_ID: RUN,
};
const HOST_KEYS = [...Object.keys(hostEnv), 'ARCHON_HOME', 'SDLC_OUTPUT_ROOT'];
const inherited = HOST_KEYS.map(key => [key, process.env[key]] as const);

beforeAll(() => {
  Object.assign(process.env, hostEnv);
});

afterAll(() => {
  for (const [key, value] of inherited) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The artifact directory of the run, in a fresh project under a fresh Archon home. */
function artifactsDir(): string {
  const home = track(mkdtempSync(join(tmpdir(), 'sdlc-report-home-')));
  const outputRoot = join(home, 'workspaces', 'acme', 'widget');
  Object.assign(process.env, { ARCHON_HOME: home, SDLC_OUTPUT_ROOT: outputRoot });
  const dir = getRunArtifactsDirForRoot(outputRoot, RUN);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A typed output as the engine writes it. */
async function typed(
  dir: string,
  nodeId: string,
  outputType: string,
  producedAt: string,
  result: Record<string, unknown>
): Promise<void> {
  await writeNodeArtifact(
    dir,
    { nodeId, outputType, runId: RUN, producedAt },
    JSON.stringify(result)
  );
}

/** The report as a tail composes it, from its own run's typed outputs. */
function report(dir: string): string {
  return caveats(dir, { run: RUN });
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
    const reviewed = new Date('2026-09-10T09:00:00.000Z');
    await typed(dir, 'review__publish', 'review-report', reviewed.toISOString(), {
      discoveries: [record('Stale mock type')],
    });
    writeFileSync(
      join(dir, 'discoveries', 'review-simplify.json'),
      JSON.stringify([record('Found after review')])
    );
    const later = new Date(reviewed.getTime() + 60_000);
    utimesSync(join(dir, 'discoveries', 'review-simplify.json'), later, later);
    const text = report(dir);
    expect(text).toContain('- Stale mock type [unrelated]');
    expect(text).toContain('- Found after review [unreviewed]');
    expect(text).not.toContain('Seen by review');
    expect(text).toContain('If you are an agent reading this');
  });

  it('relays every raw record when no review ran', () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'plan.json'),
      JSON.stringify([record('Planner found it')])
    );
    expect(report(dir)).toContain('- Planner found it [unreviewed]');
  });

  it("lists the latest verdict's discoveries with the relay", async () => {
    const dir = artifactsDir();
    await typed(dir, 'review__publish', 'review-report', '2026-09-10T09:00:00.000Z', {
      discoveries: [record('Old')],
    });
    await typed(dir, 'recheck__publish', 'review-report', '2026-09-10T10:00:00.000Z', {
      discoveries: [record('Flaky timeout')],
    });
    const text = report(dir);
    expect(text).toContain('- Flaky timeout [unrelated]');
    expect(text).not.toContain('- Old');
    expect(text).toContain('If you are an agent reading this');
  });

  it('says nothing when the final verdict recorded no discoveries', async () => {
    const dir = artifactsDir();
    await typed(dir, 'review__publish', 'review-report', '2026-09-10T09:00:00.000Z', {
      discoveries: [],
    });
    expect(report(dir)).toBe('');
  });

  it('names outputs it cannot read instead of reading as no discoveries', () => {
    const dir = artifactsDir();
    expect(caveats(dir, { run: undefined })).toContain('Discoveries could not be listed');
    // A run whose output location the engine cannot resolve.
    process.env.SDLC_OUTPUT_ROOT = join(tmpdir(), 'outside-the-archon-home');
    expect(report(dir)).toContain('Discoveries could not be listed: run run could not be read');
  });
});

describe('failed', () => {
  it('claims no result and still relays the discoveries the run recorded', () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'implement.json'),
      JSON.stringify([{ title: 'Guard refuses an empty diff', relation: 'note' }])
    );
    const text = failed(dir, { run: RUN, outcomesFile: undefined });
    expect(text.startsWith('Not done:')).toBe(true);
    expect(text).toContain('- Guard refuses an empty diff [unreviewed]');
    expect(text).not.toContain('Ready');
  });
});

/**
 * Each tail's `report` node, run as the engine runs it: the outcome binding as env
 * text and this run's id, with stdout as the node's result.
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
    tail: 'ship',
    result: 'delivered',
    passed: { delivered: true, reason: 'delivered', pr_url: 'https://pr/1', summary: 'Ready.' },
  },
])('$tail report node', ({ tail, result, passed }) => {
  const script = join(import.meta.dir, '..', '.archon/workflows/sdlc', tail, 'scripts/report.ts');

  function run(outcome: string): Record<string, unknown> {
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
        INPUTS_OUTCOME: outcome,
      },
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as Record<string, unknown>;
  }

  it('reports a failed run as not done, with the discoveries it recorded', () => {
    const report = run('null');
    expect(report[result]).toBe(false);
    expect(report.reason).toBe('failed');
    expect(String(report.summary)).toStartWith('Not done:');
    expect(String(report.summary)).toContain('- Guard refuses an empty diff [unreviewed]');
  });

  it("relays the outcome node's report unchanged when it ran", () => {
    expect(run(JSON.stringify(passed))).toEqual(passed);
  });
});
