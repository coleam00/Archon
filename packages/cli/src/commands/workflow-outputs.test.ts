import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { workflowOutputsCommand } from './workflow-outputs';

const RUN_ID = 'run-outputs';

let archonHome: string;
let previousHome: string | undefined;
let artifactsDir: string;
let stdout: string[];
let stdoutSpy: ReturnType<typeof spyOn>;

function host(): WorkflowHost {
  const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
  return {
    deps: {
      store: {
        getWorkflowRun: async (id: string) =>
          id === RUN_ID ? { id: RUN_ID, output_root: outputRoot, codebase_id: null } : null,
      },
    },
    records: { codebases: { getCodebase: async () => null } },
  } as unknown as WorkflowHost;
}

/** One typed-output sidecar pair, as the engine leaves it under `nodes/`. */
function typedOutput(
  nodeId: string,
  outputType: string,
  producedAt: string,
  content: string
): void {
  mkdirSync(join(artifactsDir, 'nodes'), { recursive: true });
  writeFileSync(join(artifactsDir, 'nodes', `${nodeId}.md`), content);
  writeFileSync(
    join(artifactsDir, 'nodes', `${nodeId}.meta.json`),
    JSON.stringify({
      nodeId,
      outputType,
      path: `nodes/${nodeId}.md`,
      runId: RUN_ID,
      producedAt,
      size: content.length,
    })
  );
}

const stdoutJson = (): unknown => JSON.parse(stdout.join(''));

describe('workflowOutputsCommand', () => {
  beforeEach(() => {
    previousHome = process.env.ARCHON_HOME;
    archonHome = mkdtempSync(join(tmpdir(), 'archon-outputs-home-'));
    process.env.ARCHON_HOME = archonHome;
    artifactsDir = getRunArtifactsDirForRoot(
      join(archonHome, 'workspaces', 'acme', 'widget'),
      RUN_ID
    );
    stdout = [];
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void
    ) => {
      stdout.push(String(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    removeTempTree(archonHome);
  });

  it("returns each run's selected typed outputs with their values in one document", async () => {
    typedOutput('review', 'verdict', '2026-06-03T00:00:02.000Z', '{"ready":true}');
    typedOutput('plan', 'plan', '2026-06-03T00:00:01.000Z', 'the plan');

    expect(await workflowOutputsCommand(host(), [RUN_ID], { json: true })).toBe(0);
    expect(stdoutJson()).toEqual({
      runs: [
        {
          runId: RUN_ID,
          artifactsDir,
          artifacts: 'present',
          outputs: [
            {
              nodeId: 'plan',
              outputType: 'plan',
              producedAt: '2026-06-03T00:00:01.000Z',
              value: 'the plan',
            },
            {
              nodeId: 'review',
              outputType: 'verdict',
              producedAt: '2026-06-03T00:00:02.000Z',
              value: { ready: true },
            },
          ],
          unreadable: [],
        },
      ],
    });

    for (const filter of [{ type: 'verdict' }, { node: 'review' }]) {
      stdout = [];
      await workflowOutputsCommand(host(), [RUN_ID], { json: true, ...filter });
      const { runs } = stdoutJson() as { runs: { outputs: { nodeId: string }[] }[] };
      expect(runs[0]?.outputs.map(output => output.nodeId)).toEqual(['review']);
    }
  });

  it('answers a run whose artifacts are gone as missing, and exits 0', async () => {
    expect(await workflowOutputsCommand(host(), [RUN_ID], { json: true })).toBe(0);
    expect(stdoutJson()).toEqual({ runs: [{ runId: RUN_ID, artifactsDir, artifacts: 'missing' }] });

    stdout = [];
    expect(await workflowOutputsCommand(host(), [RUN_ID], {})).toBe(0);
    expect(stdout.join('')).toContain('are gone');
  });

  it('answers every named run, and exits 1 when one of them is unknown', async () => {
    typedOutput('plan', 'plan', '2026-06-03T00:00:01.000Z', 'the plan');

    expect(await workflowOutputsCommand(host(), ['nope', RUN_ID], { json: true })).toBe(1);
    expect(stdoutJson()).toMatchObject({
      runs: [
        { runId: 'nope', artifacts: 'unknown', error: 'Workflow run not found: nope' },
        { runId: RUN_ID, artifacts: 'present', outputs: [{ nodeId: 'plan' }] },
      ],
    });
  });

  it('fails an invocation that names no run as one --json document', async () => {
    expect(await workflowOutputsCommand(host(), [], { json: true })).toBe(1);
    expect(stdoutJson()).toMatchObject({
      ok: false,
      error: expect.stringContaining('Usage: archon workflow outputs'),
    });
  });
});
