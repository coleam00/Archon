import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry, registerBuiltinProviders } from '@archon/providers';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { runAttention } from '@archon/workflows/schemas/workflow-run';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { loadConfig } from '@archon/core/config/config-loader';
import * as connection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { PostgresAdapter } from '@archon/core/db/adapters/postgres';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';
import type { WorkflowHost } from '@archon/core/workflows/host-store';

const tempRoots = trackTempRoots();
const priorEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...priorEnv };
});

test('real CLI commands pause, approve, resume and query one run without SQL', async () => {
  const root = tempRoots(mkdtempSync(join(tmpdir(), 'archon-cli-store-')));
  const project = join(root, 'project');
  const archonHome = join(root, 'home');
  process.env.ARCHON_HOME = archonHome;
  process.env.ARCHON_TELEMETRY_DISABLED = '1';
  delete process.env.ARCHON_USER_ID;
  delete process.env.USER;
  delete process.env.USERNAME;
  delete process.env.DATABASE_URL;
  setPlatformPolicies([]);
  registerBuiltinProviders();
  mkdirSync(join(project, '.archon', 'workflows'), { recursive: true });
  writeFileSync(
    join(project, '.archon', 'workflows', 'portable.yaml'),
    `name: portable
description: exercise a supplied CLI host
interactive: true
worktree:
  enabled: false
nodes:
  - id: before
    bash: echo executed >> before-count; echo before
  - id: review
    depends_on: [before]
    approval:
      message: Approve the result?
      decisions:
        - id: approve
        - id: reject
  - id: after
    depends_on: [review]
    bash: echo finished > "$ARTIFACTS_DIR/result.txt"; printf '%s' "$ARTIFACTS_DIR" > artifact-dir; echo finished
`
  );
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const deps = {
    store,
    providers: providerRegistry,
    loadConfig,
    getAgentProvider: (): never => {
      throw new Error('No AI provider needed');
    },
  };
  const host: WorkflowHost = {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createWorkflowOperations({
      getUserRole: async userId => (await records.users.getUserById(userId))?.role,
      store,
      hostStore: records,
      requestDetachedRunStop: async () => {
        throw new Error('No detached run');
      },
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      reclaimRunWorktree: async () => {
        throw new Error('No worktree');
      },
      reclaimContainerEnv: async () => {
        throw new Error('No container');
      },
    }),
  };
  let sqlAccesses = 0;
  const failSql = (): never => {
    sqlAccesses++;
    throw new Error('CLI reached SQL');
  };
  const traps = [
    spyOn(connection, 'getDatabase').mockImplementation(failSql),
    spyOn(connection.pool, 'query').mockImplementation(failSql),
    spyOn(SqliteAdapter.prototype, 'query').mockImplementation(failSql),
    spyOn(PostgresAdapter.prototype, 'query').mockImplementation(failSql),
  ];
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const output: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation(
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void
    ): boolean => {
      output.push(String(chunk));
      if (typeof encodingOrCallback === 'function') encodingOrCallback();
      else callback?.();
      return true;
    }
  );
  try {
    expect(() => connection.getDatabase()).toThrow('CLI reached SQL');
    sqlAccesses = 0;
    const {
      workflowRunCommand,
      workflowApproveCommand,
      workflowResumeCommand,
      workflowGetCommand,
      workflowRunsCommand,
      workflowStatusCommand,
      workflowLogsCommand,
    } = await import('./workflow');
    await workflowRunCommand(host, project, 'portable', 'Run the portable workflow', {
      folder: true,
      noWorktree: true,
      quiet: true,
      conversationId: 'transport-only',
    });
    const paused = (await store.listWorkflowRuns()).runs[0];
    expect(paused?.status).toBe('paused');
    if (!paused) throw new Error('Run not recorded');
    expect(runAttention(paused)?.kind).toBe('awaiting_response');
    expect(paused.origin).toBeNull();
    expect(paused.conversation_id).toBeNull();
    expect(readFileSync(join(project, 'before-count'), 'utf8')).toBe('executed\n');

    output.length = 0;
    await workflowStatusCommand(host, project, { json: true });
    expect(JSON.parse(output.join('').trim()).runs[0].id).toBe(paused.id);
    output.length = 0;
    await workflowApproveCommand(host, paused.id, 'Ship it', true, project);
    expect(JSON.parse(output.join('').trim())).toMatchObject({
      ok: true,
      action: 'approve',
      runId: paused.id,
      resumable: true,
    });
    output.length = 0;
    expect((await store.getWorkflowRun(paused.id))?.status).toBe('paused');
    const snapshot = await store.getDagResumeSnapshot(paused.id);
    expect(snapshot.completedNodeOutputs.get('review')?.structuredOutput).toEqual({
      decision: 'approve',
      text: 'Ship it',
    });
    await workflowResumeCommand(host, paused.id, false, project);
    const completed = await store.getWorkflowRun(paused.id);
    expect(completed?.status).toBe('completed');
    expect((await store.listWorkflowRuns()).total).toBe(1);
    expect(readFileSync(join(project, 'before-count'), 'utf8')).toBe('executed\n');
    const artifactDir = readFileSync(join(project, 'artifact-dir'), 'utf8');
    expect(readFileSync(join(artifactDir, 'result.txt'), 'utf8')).toBe('finished\n');
    expect(
      (await store.listWorkflowEvents(paused.id)).filter(
        event => event.event_type === 'workflow_completed'
      )
    ).toHaveLength(1);

    output.length = 0;
    await workflowGetCommand(host, paused.id, true, true, project);
    expect(JSON.parse(output.join('').trim()).id).toBe(paused.id);
    output.length = 0;
    await workflowRunsCommand(host, project, { json: true });
    expect(JSON.parse(output.join('').trim()).runs).toMatchObject([{ id: paused.id }]);
    output.length = 0;
    await workflowLogsCommand(host, paused.id, false, project);
    expect(output.join('')).toContain(paused.id);
    expect(sqlAccesses).toBe(0);
    expect(existsSync(join(archonHome, 'archon.db'))).toBe(false);
  } finally {
    stdout.mockRestore();
    log.mockRestore();
    for (const trap of traps) trap.mockRestore();
  }
}, 30_000);

test('CLI run commands and reusable persistence helpers have no SQL imports or re-exports', () => {
  const repository = join(import.meta.dir, '../../..');
  const files = [
    'cli/src/commands/workflow.ts',
    'cli/src/adapters/cli-adapter.ts',
    'cli/src/utils/owned-run-termination.ts',
    'cli/src/utils/cli-user.ts',
    'core/src/handlers/clone.ts',
    'core/src/services/codebase-checkout-resolver.ts',
    'core/src/workflows/child-isolation-resolver.ts',
    'core/src/operations/workflow-adoption.ts',
  ];
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  for (const file of files) {
    const imports = scanner.scan(readFileSync(join(repository, file), 'utf8')).imports;
    for (const dependency of imports) {
      expect(dependency.path, file).not.toMatch(
        /(?:^|\/)db(?:\/|$)|(?:sql-host|sql-registration|store-adapter|isolation-store)$/
      );
      expect(dependency.path, file).not.toBe('@archon/core');
      expect(dependency.path, file).not.toBe('@archon/core/workflows');
    }
  }
});
