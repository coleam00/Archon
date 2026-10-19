import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  getRunArtifactsDirForRoot,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
  setLogDestination,
} from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { workflowArtifactsCommand } from './workflow-artifacts';

const RUN_ID = 'run-artifacts';

let archonHome: string;
let previousHome: string | undefined;
let stdout: Uint8Array[];
let stderr: string[];
let stdoutSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;

function capture(sink: (chunk: string | Uint8Array) => void) {
  return ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    sink(chunk);
    callback?.();
    return true;
  }) as typeof process.stdout.write;
}

function hostFor(outputRoot: string | null): WorkflowHost {
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

const stdoutText = (): string => Buffer.concat(stdout).toString('utf8');
const stdoutJson = (): Record<string, unknown> =>
  JSON.parse(stdoutText()) as Record<string, unknown>;

describe('workflowArtifactsCommand', () => {
  let outputRoot: string;
  let artifactsDir: string;

  beforeEach(() => {
    previousHome = process.env.ARCHON_HOME;
    archonHome = mkdtempSync(join(tmpdir(), 'archon-artifacts-home-'));
    process.env.ARCHON_HOME = archonHome;
    outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    artifactsDir = getRunArtifactsDirForRoot(outputRoot, RUN_ID);
    stdout = [];
    stderr = [];
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      capture(chunk => stdout.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    );
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
      capture(chunk => stderr.push(String(chunk)))
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    removeTempTree(archonHome);
  });

  it('lists every workflow file, uncapped, and counts the engine child without listing it', async () => {
    mkdirSync(join(artifactsDir, 'review'), { recursive: true });
    mkdirSync(join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR), { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(join(artifactsDir, `f${String(i)}.md`), 'x');
    writeFileSync(join(artifactsDir, 'review', 'report.md'), 'x');
    writeFileSync(join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'listing.json'), '{}');

    const code = await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID], { json: true });

    expect(code).toBe(0);
    const out = stdoutJson();
    const files = out.files as string[];
    expect(files).toHaveLength(206);
    expect(files).toContain('review/report.md');
    expect(files.some(file => file.startsWith(RUN_ARTIFACTS_ENGINE_SUBDIR))).toBe(false);
    expect(out).toMatchObject({ runId: RUN_ID, artifactsDir, internalFiles: 1, unreadable: [] });
  });

  it('prints the exact bytes of a nested file, and its text under --json', async () => {
    mkdirSync(join(artifactsDir, 'review'), { recursive: true });
    writeFileSync(join(artifactsDir, 'review', 'report.md'), '# Report\nok\n');

    expect(
      await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID, 'review/report.md'], {})
    ).toBe(0);
    expect(stdoutText()).toBe('# Report\nok\n');

    stdout = [];
    await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID, 'review/report.md'], {
      json: true,
    });
    expect(stdoutJson()).toEqual({
      runId: RUN_ID,
      path: 'review/report.md',
      content: '# Report\nok\n',
    });
  });

  it('refuses a parent-relative path and a symlink out of the run directory', async () => {
    mkdirSync(artifactsDir, { recursive: true });
    const outside = join(archonHome, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(artifactsDir, 'link.txt'));

    for (const path of [relative(artifactsDir, outside), 'link.txt']) {
      stderr = [];
      expect(await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID, path], {})).toBe(1);
      expect(stderr.join('')).toContain('is outside run');
    }
    expect(stdout).toHaveLength(0);
  });

  it('reports an unknown run, a missing path and a directory as one --json failure each', async () => {
    mkdirSync(join(artifactsDir, 'review'), { recursive: true });
    writeFileSync(join(artifactsDir, 'plan.md'), 'x');

    const cases: [string[], string][] = [
      [['nope'], 'Workflow run not found: nope'],
      [[RUN_ID, 'missing.md'], 'Artifact not found: missing.md'],
      [[RUN_ID, 'plan.md/x'], 'Artifact not found: plan.md/x'],
      [[RUN_ID, 'review'], 'review is a directory'],
      [[RUN_ID, '.'], '. is a directory'],
      [[RUN_ID, 'plan.md', 'extra'], 'Usage: archon workflow artifacts'],
    ];
    for (const [args, error] of cases) {
      stdout = [];
      expect(await workflowArtifactsCommand(hostFor(outputRoot), args, { json: true })).toBe(1);
      const out = stdoutJson();
      expect(out).toMatchObject({ ok: false });
      if (!error.startsWith('Usage')) expect(out.runId).toBe(args[0]);
      expect(out.error).toContain(error);
    }
  });

  it('reports a failed codebase lookup as one --json failure carrying the run id', async () => {
    const host = {
      deps: {
        store: {
          getWorkflowRun: async () => ({ id: RUN_ID, output_root: null, codebase_id: 'cb' }),
        },
      },
      records: {
        codebases: {
          getCodebase: async () => {
            throw new Error('database is locked');
          },
        },
      },
    } as unknown as WorkflowHost;

    // As in the CLI, so the failure log does not land in the JSON stream.
    setLogDestination('stderr');
    try {
      expect(await workflowArtifactsCommand(host, [RUN_ID], { json: true })).toBe(1);
    } finally {
      setLogDestination('stdout');
    }
    expect(stdoutJson()).toEqual({ ok: false, runId: RUN_ID, error: 'database is locked' });
    expect(stderr.join('')).toContain('cli.workflow_artifacts_failed');
  });

  it('refuses a non-UTF-8 file under --json but prints its bytes without it', async () => {
    mkdirSync(artifactsDir, { recursive: true });
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    writeFileSync(join(artifactsDir, 'clip.bin'), bytes);

    expect(
      await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID, 'clip.bin'], { json: true })
    ).toBe(1);
    expect(stdoutJson()).toMatchObject({ ok: false, runId: RUN_ID });
    expect(stdoutJson().error).toContain('is not UTF-8 text');

    stdout = [];
    expect(await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID, 'clip.bin'], {})).toBe(0);
    expect(new Uint8Array(Buffer.concat(stdout))).toEqual(bytes);
  });

  it('fails when the output location is unresolvable, but lists nothing for a run that wrote nothing', async () => {
    expect(await workflowArtifactsCommand(hostFor(null), [RUN_ID], { json: true })).toBe(1);
    expect(stdoutJson()).toMatchObject({ ok: false, runId: RUN_ID });

    stdout = [];
    expect(await workflowArtifactsCommand(hostFor(outputRoot), [RUN_ID], { json: true })).toBe(0);
    expect(stdoutJson()).toMatchObject({ files: [], internalFiles: 0 });
  });
});
