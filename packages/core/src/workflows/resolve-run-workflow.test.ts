// @archon-test-isolated
import { createWorkflowDeps } from './store-adapter';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  WorkflowSourceUnavailableError,
  captureWorkflowSource,
} from '../../../workflows/src/workflow-source';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { resolveRunWorkflow } from './resolve-run-workflow';

const trackTempRoot = trackTempRoots();

// Live discovery loads config; a stub keeps these tests off this machine's ~/.archon.
function workflowDeps(): WorkflowDeps {
  return {
    ...createWorkflowDeps(),
    loadConfig: async () => ({
      assistant: 'claude',
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conversation-1' },
    id: 'run-1',
    workflow_name: 'continued',
    conversation_id: 'conversation-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'paused',
    outcome: null,
    user_message: 'continue',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

async function writeWorkflow(root: string, description: string): Promise<void> {
  await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(root, '.archon', 'workflows', 'continued.yaml'),
    `name: continued\ndescription: ${description}\nnodes:\n  - id: work\n    prompt: Do the work\n`
  );
}

function capturedMetadata(capture: Awaited<ReturnType<typeof captureWorkflowSource>>) {
  return {
    workflow_source: {
      version: 1 as const,
      root: capture.anchor.root,
      origin: capture.origin,
      captured_at: capture.manifest.captured_at,
      digest: capture.manifest.digest,
      source_config: capture.manifest.source_config,
      file_count: capture.manifest.file_count,
      byte_count: capture.manifest.byte_count,
    },
  };
}

describe('resolveRunWorkflow', () => {
  test('uses a run capture when the live same-name workflow conflicts', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-resolve-run-')));
    const source = join(root, 'source');
    await writeWorkflow(source, 'Captured graph');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(root, 'capture'),
    });
    await writeWorkflow(source, 'Conflicting live graph');

    const result = await resolveRunWorkflow(
      workflowDeps(),
      makeRun({
        metadata: capturedMetadata(capture),
      }),
      source,
      {}
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workflow.description).toBe('Captured graph');
  });

  test('refuses a missing capture without falling back to a live same-name workflow', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-run-source-')));
    const source = join(root, 'source');
    await writeWorkflow(source, 'Live graph must not substitute');
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(root, 'capture'),
    });
    await rm(capture.anchor.root, { recursive: true });

    const result = await resolveRunWorkflow(
      workflowDeps(),
      makeRun({ metadata: capturedMetadata(capture) }),
      source,
      {}
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('recorded workflow source is unavailable');
      expect(result.sourceError).toBeInstanceOf(WorkflowSourceUnavailableError);
      expect(result.sourceError?.path).toBe(join(capture.anchor.root, 'manifest.json'));
      expect(result.resumeHint).toBe('Start a fresh run to execute the current workflow.');
    }
  });

  test('uses live discovery only for a run without a capture', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-resolve-legacy-run-')));
    await writeWorkflow(root, 'Legacy live graph');

    const result = await resolveRunWorkflow(workflowDeps(), makeRun(), root, {});

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workflow.description).toBe('Legacy live graph');
  });

  test('reports a malformed legacy workflow instead of treating it as absent', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-malformed-legacy-run-')));
    await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
    await writeFile(join(root, '.archon', 'workflows', 'continued.yaml'), 'name: [invalid');

    const result = await resolveRunWorkflow(workflowDeps(), makeRun(), root, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Workflow `continued` failed to load:');
      expect(result.message).toContain('Fix the YAML file and try again.');
    }
  });

  test('refuses the run when its config fails to load', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-config-error-run-')));
    await writeWorkflow(root, 'Legacy live graph');
    const configError = new Error(
      `Invalid model binding config in '${join(root, '.archon', 'config.yaml')}': tiers.medium.thinking`
    );

    const result = await resolveRunWorkflow(
      {
        ...workflowDeps(),
        loadConfig: async () => {
          throw configError;
        },
      },
      makeRun(),
      root,
      {}
    );

    expect(result).toEqual({
      ok: false,
      message: `Failed to load workflows: ${configError.message}`,
    });
  });

  test('reports a missing legacy workflow', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-legacy-run-')));

    const result = await resolveRunWorkflow(workflowDeps(), makeRun(), root, {});

    expect(result).toEqual({
      ok: false,
      message:
        'Workflow `continued` for run run-1 was not found.\n\n' +
        'Use /workflow list to check available workflows.',
    });
  });

  test('spells the list command for the surface', async () => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-legacy-run-')));

    const result = await resolveRunWorkflow(workflowDeps(), makeRun(), root, {
      formatWorkflowCommand: command => `/archon-workflow ${command}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Use /archon-workflow list');
  });
});
