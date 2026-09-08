import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowGetOutput } from './workflow';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const STORAGE_CASES = ['persisted', 'legacy', 'relocated', 'missing', 'refused', 'empty'] as const;
type Storage = (typeof STORAGE_CASES)[number];
const ARTIFACT_FILE = 'nested folder/report with spaces.md';

interface RunFixture {
  id: string;
  outputRoot: string | null;
  artifactsDir: string | null;
  artifactFiles: string[];
}

let root: string;
let cwd: string;
let userHome: string;
let archonHome: string;
let initialDirectories: string[];
const runs = new Map<Storage, RunFixture>();
const children = new Map<Bun.Subprocess, Promise<unknown>>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'archon get artifacts '));
  archonHome = join(root, 'active home');
  cwd = join(root, 'unrelated cwd');
  userHome = join(root, 'unrelated user home');
  mkdirSync(cwd);
  mkdirSync(userHome);

  // Seed all cases once through the production schema. The CLI only reads these
  // runs; separate IDs let the modes share evidence without per-test DB setup.
  const database = new SqliteAdapter(join(archonHome, 'archon.db'));
  try {
    await database.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd, kind) VALUES ($1, $2, $3, $4)',
      ['unrelated-codebase', 'unrelated folder', await canonicalizeProjectPath(cwd), 'folder']
    );
    await database.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['codebase-1', 'current/project', join(root, 'owner checkout')]
    );
    await database.query(
      'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)',
      ['conversation-1', 'cli', 'artifact-fixture']
    );
    for (const [index, storage] of STORAGE_CASES.entries()) {
      const id = `53eb3579-1111-4444-8888-${String(index + 1).padStart(12, '0')}`;
      const hasCodebase = storage !== 'missing' && storage !== 'refused';
      const outputRoot =
        storage === 'persisted' || storage === 'empty'
          ? join(archonHome, 'workspaces', 'original owner', 'original project')
          : storage === 'relocated' || storage === 'refused'
            ? join(root, 'old installation', 'workspaces', 'old', 'project')
            : null;
      const resolvedRoot =
        storage === 'persisted' || storage === 'empty'
          ? outputRoot
          : hasCodebase
            ? join(archonHome, 'workspaces', 'current', 'project')
            : null;
      const artifactsDir = resolvedRoot ? join(resolvedRoot, 'artifacts', 'runs', id) : null;
      const artifactFiles = artifactsDir && storage !== 'empty' ? [ARTIFACT_FILE] : [];
      await database.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status, output_root)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          'conversation-1',
          hasCodebase ? 'codebase-1' : null,
          'fixture',
          'test',
          'completed',
          outputRoot,
        ]
      );
      if (artifactsDir && storage !== 'empty') {
        mkdirSync(join(artifactsDir, 'nested folder'), { recursive: true });
        writeFileSync(join(artifactsDir, ARTIFACT_FILE), 'evidence');
      }
      if ((storage === 'refused' || storage === 'relocated') && outputRoot) {
        const decoy = join(outputRoot, 'artifacts', 'runs', id);
        mkdirSync(decoy, { recursive: true });
        writeFileSync(join(decoy, 'wrong-installation.txt'), 'decoy');
      }
      runs.set(storage, { id, outputRoot, artifactsDir, artifactFiles });
    }
  } finally {
    await database.close();
  }
  initialDirectories = directories();
});

async function settleChildren(): Promise<void> {
  // A timeout can leave runCli pending. Stop only children recorded by this file
  // and drain their exit/streams before another case or final fixture removal.
  const pending = [...children];
  for (const [child] of pending) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.allSettled(pending.map(([, completion]) => completion));
}

afterEach(settleChildren);
afterAll(async () => {
  await settleChildren();
  if (root) await removeTempTree(root);
});

function fixture(storage: Storage): RunFixture {
  const run = runs.get(storage);
  if (!run) throw new Error(`Missing ${storage} fixture`);
  return run;
}

async function runCli(run: RunFixture, flags: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, CLI_PATH, 'workflow', 'get', run.id, ...flags], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: '',
      ARCHON_HOME: archonHome,
      HOME: userHome,
      USERPROFILE: userHome,
      ARCHON_TELEMETRY_DISABLED: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const results = [
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ] as const;
  const settled = Promise.allSettled(results);
  children.set(child, settled);
  try {
    const [exitCode, stdout, stderr] = await Promise.all(results);
    if (exitCode !== 0)
      throw new Error(`workflow get exited ${String(exitCode)}: ${stderr || stdout}`);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    return stdout;
  } finally {
    // Keep ownership until every stream and the process itself have settled,
    // even if one stream rejects before the child exits.
    await settled;
    children.delete(child);
  }
}

function directories(): string[] {
  // Bun initializes its own cache under the substituted user home. Inspect
  // Archon's storage and cwd, and separately reject default-home Archon writes.
  expect(existsSync(join(userHome, '.archon'))).toBe(false);
  return [archonHome, cwd].flatMap(directory =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(entry.parentPath, entry.name))
      .sort()
  );
}

function expectArtifacts(output: WorkflowGetOutput, run: RunFixture): void {
  expect(output).toMatchObject({
    id: run.id,
    status: 'completed',
    output_root: run.outputRoot,
    artifacts_dir: run.artifactsDir,
    leave_behind: { adopted_by: [], artifactFiles: run.artifactFiles },
  });
  if (output.artifacts_dir) {
    for (const file of output.leave_behind?.artifactFiles ?? []) {
      expect(readFileSync(join(output.artifacts_dir, file), 'utf8')).toBe('evidence');
    }
  }
  expect(directories()).toEqual(initialDirectories);
}

describe('workflow get artifact discovery through the public CLI', () => {
  // Storage resolution is covered in compact JSON. The persisted case also
  // exercises each public mode; workflow.test.ts covers the in-process payloads.
  test.each([...STORAGE_CASES])(
    '%s storage in compact JSON without creating directories',
    async storage => {
      const run = fixture(storage);
      const output = JSON.parse(await runCli(run, ['--json'])) as WorkflowGetOutput;
      expectArtifacts(output, run);
      expect(output.nodes).toBeUndefined();
      expect(output.events).toBeUndefined();
      if (storage === 'empty') {
        if (run.artifactsDir === null) throw new Error('Expected an owned artifacts directory');
        expect(existsSync(run.artifactsDir)).toBe(false);
      }
    }
  );

  test('persisted storage in verbose JSON without creating directories', async () => {
    const run = fixture('persisted');
    const output = JSON.parse(await runCli(run, ['--json', '--verbose'])) as WorkflowGetOutput;
    expectArtifacts(output, run);
    expect(output.nodes).toEqual([]);
    expect(output.events).toBeUndefined();
  });

  test('persisted storage in raw-event JSON without creating directories', async () => {
    const run = fixture('persisted');
    const output = JSON.parse(
      await runCli(run, ['--json', '--verbose', '--events'])
    ) as WorkflowGetOutput;
    expectArtifacts(output, run);
    expect(output.events).toEqual([]);
    expect(output.nodes).toBeUndefined();
  });

  test('persisted storage in human output without creating directories', async () => {
    const human = await runCli(fixture('persisted'), []);
    expect(human).toContain('Artifacts (1 files under $ARTIFACTS_DIR):');
    expect(human).toContain(ARTIFACT_FILE);
    expect(human).not.toContain('artifacts_dir');
    expect(directories()).toEqual(initialDirectories);
  });
});
