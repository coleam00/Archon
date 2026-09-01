import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '../utils/detached-run-control';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();

afterEach(async () => {
  for (const runId of activeRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed owner has already removed its endpoint.
    }
  }
  activeRunIds.clear();
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  projectRoot: string;
  archonHome: string;
  readyPath: string;
  releasePath: string;
}

function makeFixture(prefix: string, workflowName: string): Fixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(fixtureRoot);
  const projectRoot = join(fixtureRoot, 'project');
  const workflowsDir = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, `${workflowName}.yaml`),
    `name: ${workflowName}\ndescription: Transcript integration fixture.\n` +
      'nodes:\n' +
      '  - id: hold\n' +
      '    bash: |\n' +
      '      touch .transcript-ready\n' +
      '      while [ ! -f .transcript-release ]; do sleep 0.05; done\n' +
      "      printf 'transcript-output\\n'\n"
  );
  return {
    projectRoot,
    archonHome: join(fixtureRoot, 'home'),
    readyPath: join(projectRoot, '.transcript-ready'),
    releasePath: join(projectRoot, '.transcript-release'),
  };
}

function spawnCli(fixture: Fixture, args: string[]): Bun.ReadableSubprocess {
  return Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ARCHON_HOME: fixture.archonHome,
      ARCHON_TELEMETRY_DISABLED: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function runCli(
  fixture: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawnCli(fixture, args);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function readRunId(archonHome: string, workflowName: string): string | undefined {
  const databasePath = join(archonHome, 'archon.db');
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ id: string }, [string]>(
        `SELECT id FROM remote_agent_workflow_runs
         WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1`
      )
      .get(workflowName)?.id;
  } finally {
    database.close();
  }
}

async function waitFor<T>(what: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${what}${detail}`);
}

interface TranscriptFollower {
  attached(): Promise<string>;
  settled(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function startFollower(fixture: Fixture, runId: string): TranscriptFollower {
  const child = spawnCli(fixture, ['workflow', 'logs', runId, '--follow']);
  let announce: ((path: string) => void) | undefined;
  let abandon: ((error: Error) => void) | undefined;
  const attached = new Promise<string>((resolveAttached, rejectAttached) => {
    announce = resolveAttached;
    abandon = rejectAttached;
  });
  attached.catch(() => undefined);

  const stderrText = (async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    let scanned = 0;
    const scan = (): void => {
      for (
        let newline = text.indexOf('\n', scanned);
        announce && newline !== -1;
        newline = text.indexOf('\n', scanned)
      ) {
        const line = text.slice(scanned, newline);
        scanned = newline + 1;
        const prefix = 'Following transcript: ';
        if (line.startsWith(prefix)) {
          announce(line.slice(prefix.length));
          announce = undefined;
        }
      }
    };
    for await (const chunk of child.stderr) {
      text += decoder.decode(chunk, { stream: true });
      scan();
    }
    text += decoder.decode();
    scan();
    if (announce) abandon?.(new Error(`logs exited without attaching: ${text}`));
    return text;
  })();

  return {
    attached: (): Promise<string> => attached,
    async settled(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        stderrText,
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

function parseTranscript(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function expectCompleteTranscript(rows: Record<string, unknown>[], runId: string): void {
  expect(rows.map(row => row.type)).toEqual([
    'workflow_start',
    'node_start',
    'exec_output',
    'node_complete',
    'workflow_complete',
  ]);
  expect(rows.every(row => row.workflow_id === runId)).toBe(true);
  expect(rows[2]).toMatchObject({ stdout_tail: 'transcript-output', exit_code: 0 });
}

describe('archon workflow transcript discovery and following', () => {
  test('a foreground run can be discovered and followed from another process', async () => {
    const workflowName = 'transcript-foreground';
    const fixture = makeFixture('archon-transcript-foreground-', workflowName);
    const owner = spawnCli(fixture, [
      'workflow',
      'run',
      workflowName,
      'capture the foreground transcript',
      '--folder',
    ]);
    const runId = await waitFor('the foreground run row', () =>
      readRunId(fixture.archonHome, workflowName)
    );
    activeRunIds.add(runId);

    const follower = startFollower(fixture, runId);
    const transcriptPath = await follower.attached();
    await waitFor('the foreground bash node to start', () =>
      existsSync(fixture.readyPath) ? true : undefined
    );
    writeFileSync(fixture.releasePath, 'release\n');

    const [ownerExit, ownerStdout, ownerStderr, followed] = await Promise.all([
      owner.exited,
      new Response(owner.stdout).text(),
      new Response(owner.stderr).text(),
      follower.settled(),
    ]);
    activeRunIds.delete(runId);
    if (ownerExit !== 0) throw new Error(`foreground run failed: ${ownerStderr || ownerStdout}`);
    if (followed.exitCode !== 0) throw new Error(`logs failed: ${followed.stderr}`);

    expect(ownerStderr).toContain(`[workflow] Transcript: ${transcriptPath}`);
    const detail = await runCli(fixture, ['workflow', 'get', runId, '--json']);
    expect(detail.exitCode).toBe(0);
    expect(JSON.parse(detail.stdout.trim())).toMatchObject({
      id: runId,
      status: 'completed',
      transcript_path: transcriptPath,
    });
    expectCompleteTranscript(parseTranscript(followed.stdout), runId);
  }, 60_000);

  test('a detached ack distinguishes the transcript from child output and can be followed', async () => {
    const workflowName = 'transcript-detached';
    const fixture = makeFixture('archon-transcript-detached-', workflowName);
    const launched = await runCli(fixture, [
      'workflow',
      'run',
      workflowName,
      'capture the detached transcript',
      '--folder',
      '--detach',
      '--json',
      '--conversation-id',
      `transcript-${crypto.randomUUID()}`,
    ]);
    if (launched.exitCode !== 0) {
      throw new Error(`detached launcher failed: ${launched.stderr || launched.stdout}`);
    }
    const ack = JSON.parse(launched.stdout.trim()) as {
      runId: string;
      transcriptPath: string;
      logPath: string;
    };
    activeRunIds.add(ack.runId);
    expect(ack.transcriptPath).toEndWith(`${ack.runId}.jsonl`);
    expect(ack.logPath).not.toBe(ack.transcriptPath);
    expect(dirname(ack.logPath)).not.toBe(dirname(ack.transcriptPath));

    const follower = startFollower(fixture, ack.runId);
    expect(await follower.attached()).toBe(ack.transcriptPath);
    await waitFor('the detached bash node to start', () =>
      existsSync(fixture.readyPath) ? true : undefined
    );
    writeFileSync(fixture.releasePath, 'release\n');

    const followed = await follower.settled();
    activeRunIds.delete(ack.runId);
    if (followed.exitCode !== 0) throw new Error(`logs failed: ${followed.stderr}`);
    expectCompleteTranscript(parseTranscript(followed.stdout), ack.runId);
  }, 60_000);
});
