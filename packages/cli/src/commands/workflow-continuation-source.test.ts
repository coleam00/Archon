// @archon-test-isolated
import { expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import {
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
  loadWorkflowSource,
} from '@archon/workflows/workflow-source';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
const paths = await import('@archon/paths');
const warn = mock((_fields: unknown, _message: string) => undefined);
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ warn, error: mock(() => undefined) }),
}));
const stdout = mock(async (_text: string) => undefined);
mock.module('../utils/stdout', () => ({ writeStdout: stdout }));
const { workflowContinuationCommand, workflowWakeScheduleConfig } = await import(
  './workflow-continuations'
);
const trackTempRoot = trackTempRoots();

async function wakeScheduled(host: WorkflowHost) {
  const config = workflowWakeScheduleConfig();
  expect(config.programArguments).toContain('--watch');
  stdout.mockImplementation(async () => {
    if (stdout.mock.calls.length === 8) process.emit('SIGTERM');
  });
  const originalTimeout = globalThis.setTimeout;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation(callback =>
    originalTimeout(callback, 0)
  );
  try {
    await workflowContinuationCommand(host, 'wake', [], {
      json: true,
      watch: config.programArguments.includes('--watch'),
    });
  } finally {
    timer.mockRestore();
    stdout.mockImplementation(async () => undefined);
  }
}

function expectUnavailableOutputs(source: string, runId: string) {
  expect(warn).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledTimes(8);
  for (const [output] of stdout.mock.calls) {
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      accepted: 0,
      outcomes: [
        {
          runId,
          kind: 'unavailable',
          reason: expect.stringContaining(
            source.endsWith('foreign-origin')
              ? 'CLI cannot deliver results'
              : source.endsWith('missing-origin')
                ? 'origin conversation no longer exists'
                : 'recorded working path is unavailable:'
          ),
        },
      ],
    });
  }
}

for (const source of [
  'missing',
  'missing-unrecorded-path',
  'valid',
  'scheduled',
  'missing-origin',
  'foreign-origin',
  'valid-missing-origin',
  'valid-foreign-origin',
] as const) {
  test(`CLI wake refuses a foreign working directory with ${source} source`, async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'cli-foreign-source-')));
    const sourcePath = join(root, 'source');
    const content = 'frozen';
    const hash = createHash('sha256').update(content).digest('hex');
    const digest = createHash('sha256').update(`source.txt\0${hash}\n`).digest('hex');
    const validSource = source.startsWith('valid');
    if (validSource) {
      await mkdir(sourcePath);
      await writeFile(join(sourcePath, 'source.txt'), content);
      await writeFile(
        join(sourcePath, 'manifest.json'),
        JSON.stringify({
          version: 1,
          engine_version: BUNDLED_VERSION,
          origin: root,
          captured_at: new Date().toISOString(),
          digest,
          file_count: 1,
          byte_count: content.length,
          scopes: [],
          source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
        })
      );
      await loadWorkflowSource(sourcePath, digest);
    }
    const run: WorkflowRun = {
      id: `foreign-cli-${source}-source`,
      workflow_name: 'deliver',
      status: 'paused',
      outcome: null,
      origin: null,
      conversation_id: source.endsWith('-origin') ? 'origin' : null,
      parent_conversation_id: source.endsWith('-origin') ? 'origin' : null,
      codebase_id: null,
      user_message: '',
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: source === 'missing-unrecorded-path' ? null : join(root, 'missing-worktree'),
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
      metadata: {
        workflow_source: {
          version: 1,
          root: sourcePath,
          origin: root,
          captured_at: new Date().toISOString(),
          digest,
          file_count: 1,
          byte_count: content.length,
          source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
        },
        wait: {
          owner: 'node',
          kind: 'time',
          nodeId: 'delay',
          waitingSince: '2026-08-24T10:00:00Z',
          resumeAt: '2026-08-24T11:00:00Z',
        },
      },
    };
    const getRun = mock(async () => run);
    const defer = mock(async () => undefined);
    const execute = mock(async () => {
      throw new Error('must not execute');
    });
    const host = {
      deps: {
        store: {
          getWorkflowRun: getRun,
          listDueWorkflowContinuations: async () => [run],
          deferWorkflowContinuation: defer,
        },
      },
      records: {
        conversations: {
          getConversationById: async () =>
            source.endsWith('foreign-origin') ? { platform_type: 'slack' } : null,
        },
      },
      engine: { resume: execute },
    } as unknown as WorkflowHost;
    warn.mockClear();
    stdout.mockClear();
    if (source === 'scheduled') {
      await wakeScheduled(host);
    } else {
      for (let i = 0; i < 8; i++)
        await workflowContinuationCommand(host, 'wake', [], { json: true });
    }
    expect(getRun).toHaveBeenCalledTimes(validSource ? 8 : 3);
    expect(defer).toHaveBeenCalledTimes(validSource ? 8 : 2);
    expect(execute).not.toHaveBeenCalled();
    if (validSource) {
      expectUnavailableOutputs(source, run.id);
    } else {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([
        expect.objectContaining({ runId: run.id, path: join(sourcePath, 'manifest.json') }),
        expect.stringMatching(
          new RegExp(`archon workflow resume ${run.id}.*archon workflow abandon ${run.id}`)
        ),
      ]);
    }
    expect(run.status).toBe('paused');
  });
}
