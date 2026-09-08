import { afterEach, describe, expect, test } from 'bun:test';
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
const cleanupPaths: string[] = [];
const RUN_ID = '53eb3579-1111-4444-8888-111111111111';

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  root: string;
  cwd: string;
  userHome: string;
  archonHome: string;
  outputRoot: string | null;
  artifactsDir: string | null;
}

async function makeFixture(
  storage: 'persisted' | 'legacy' | 'relocated' | 'missing' | 'refused'
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'archon get artifacts '));
  cleanupPaths.push(root);
  const archonHome = join(root, 'active home');
  const cwd = join(root, 'unrelated cwd');
  const userHome = join(root, 'unrelated user home');
  mkdirSync(cwd);
  mkdirSync(userHome);
  const hasCodebase = storage !== 'missing' && storage !== 'refused';
  const outputRoot =
    storage === 'persisted'
      ? join(archonHome, 'workspaces', 'original owner', 'original project')
      : storage === 'relocated' || storage === 'refused'
        ? join(root, 'old installation', 'workspaces', 'old', 'project')
        : null;
  const resolvedRoot =
    storage === 'persisted'
      ? outputRoot
      : hasCodebase
        ? join(archonHome, 'workspaces', 'current', 'project')
        : null;
  const artifactsDir = resolvedRoot ? join(resolvedRoot, 'artifacts', 'runs', RUN_ID) : null;

  // The production adapter creates the current schema in a test-owned database.
  // No workflow or provider executes to manufacture the stored run.
  const database = new SqliteAdapter(join(archonHome, 'archon.db'));
  try {
    await database.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd, kind) VALUES ($1, $2, $3, $4)',
      ['unrelated-codebase', 'unrelated folder', await canonicalizeProjectPath(cwd), 'folder']
    );
    if (hasCodebase) {
      await database.query(
        'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
        ['codebase-1', 'current/project', join(root, 'owner checkout')]
      );
    }
    await database.query(
      'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)',
      ['conversation-1', 'cli', 'artifact-fixture']
    );
    await database.query(
      `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, codebase_id, workflow_name, user_message, status, output_root)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        RUN_ID,
        'conversation-1',
        hasCodebase ? 'codebase-1' : null,
        'fixture',
        'test',
        'completed',
        outputRoot,
      ]
    );
  } finally {
    await database.close();
  }

  return { root, cwd, userHome, archonHome, outputRoot, artifactsDir };
}

async function runCli(fixture: Fixture, flags: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, CLI_PATH, 'workflow', 'get', RUN_ID, ...flags], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      DATABASE_URL: '',
      ARCHON_HOME: fixture.archonHome,
      HOME: fixture.userHome,
      USERPROFILE: fixture.userHome,
      ARCHON_TELEMETRY_DISABLED: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`workflow get exited ${String(exitCode)}: ${stderr || stdout}`);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return stdout;
}

function directories(fixture: Fixture): string[] {
  // Bun initializes its own cache under the substituted user home. Inspect
  // Archon's storage and cwd, and separately reject default-home Archon writes.
  expect(existsSync(join(fixture.userHome, '.archon'))).toBe(false);
  return [fixture.archonHome, fixture.cwd].flatMap(root =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(entry.parentPath, entry.name))
      .sort()
  );
}

describe('workflow get artifact discovery through the public CLI', () => {
  test.each(['persisted', 'legacy', 'relocated', 'missing', 'refused'] as const)(
    '%s storage agrees across JSON modes without creating directories',
    async storage => {
      const fixture = await makeFixture(storage);
      if (fixture.artifactsDir) {
        mkdirSync(join(fixture.artifactsDir, 'nested folder'), { recursive: true });
        writeFileSync(
          join(fixture.artifactsDir, 'nested folder', 'report with spaces.md'),
          'evidence'
        );
      }
      if ((storage === 'refused' || storage === 'relocated') && fixture.outputRoot) {
        const decoy = join(fixture.outputRoot, 'artifacts', 'runs', RUN_ID);
        mkdirSync(decoy, { recursive: true });
        writeFileSync(join(decoy, 'wrong-installation.txt'), 'decoy');
      }
      const before = directories(fixture);
      const payloads: WorkflowGetOutput[] = [];
      for (const flags of [[], ['--verbose'], ['--verbose', '--events']]) {
        const output = JSON.parse(await runCli(fixture, ['--json', ...flags])) as WorkflowGetOutput;
        expect(output).toMatchObject({
          id: RUN_ID,
          status: 'completed',
          output_root: fixture.outputRoot,
          artifacts_dir: fixture.artifactsDir,
          leave_behind: {
            adopted_by: [],
            artifactFiles: fixture.artifactsDir ? ['nested folder/report with spaces.md'] : [],
          },
        });
        if (output.artifacts_dir) {
          for (const file of output.leave_behind?.artifactFiles ?? []) {
            expect(readFileSync(join(output.artifacts_dir, file), 'utf8')).toBe('evidence');
          }
        }
        payloads.push(output);
      }
      expect(payloads[0]?.nodes).toBeUndefined();
      expect(payloads[1]?.nodes).toEqual([]);
      expect(payloads[2]?.events).toEqual([]);
      expect(payloads[2]?.nodes).toBeUndefined();
      if (storage === 'persisted') {
        const human = await runCli(fixture, []);
        expect(human).toContain('Artifacts (1 files under $ARTIFACTS_DIR):');
        expect(human).toContain('nested folder/report with spaces.md');
        expect(human).not.toContain('artifacts_dir');
      }
      expect(directories(fixture)).toEqual(before);
    }
  );

  test('reports an owned directory that does not exist without creating it', async () => {
    const fixture = await makeFixture('persisted');
    const before = directories(fixture);
    for (const flags of [[], ['--verbose']]) {
      expect(JSON.parse(await runCli(fixture, ['--json', ...flags]))).toMatchObject({
        artifacts_dir: fixture.artifactsDir,
        leave_behind: { artifactFiles: [] },
      });
    }
    expect(directories(fixture)).toEqual(before);
  });
});
