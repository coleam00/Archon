import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

function runCli(args: string[], archonHome: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_HOME: archonHome, ARCHON_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * `workflow resume/approve/reject/respond` reach `workflowRunCommand` through the same
 * entry point `workflow run` uses, so they need the provider registry for exactly the same
 * reason — but only continuation resolves its workflow from a capture. That path passes a
 * recorded `source_config` into discovery, which is the branch that skips `loadConfig()`,
 * and `loadConfig()` is what self-registers providers for every other route. So a
 * continuation is the one caller that must arrive with the registry already populated.
 *
 * This spawns the real CLI because the gap is in dispatch, not in the command functions:
 * the in-process suite calls `workflowResumeCommand` directly and registers providers as an
 * import side effect, which is precisely how this shipped invisible.
 */
describe('workflow continuation provider registration', () => {
  test('resumes a provider-scoped workflow instead of failing its source lookup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-continuation-provider-'));
    cleanupPaths.push(root);
    const repo = join(root, 'repo');
    const archonHome = join(root, 'home');
    const workflowDir = join(repo, '.archon', 'workflows', 'provider-scoped');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(archonHome, { recursive: true });
    expect(spawnSync('git', ['init', '-q', '.'], { cwd: repo }).status).toBe(0);

    // A workflow-level `provider:` over bash-only nodes. The loader validates the provider
    // id when it loads the file, so this reproduces the registry dependency without ever
    // starting a provider. `settle` succeeds and `boom` fails, which is what leaves a run
    // that can actually be resumed — a run with no completed node is refused earlier, for
    // an unrelated reason, and would never reach the behaviour under test.
    writeFileSync(
      join(workflowDir, 'provider-scoped.yaml'),
      [
        'name: provider-scoped',
        'description: continuation provider registration',
        'provider: claude',
        'nodes:',
        '  - id: settle',
        '    bash: echo settled',
        '  - id: boom',
        '    depends_on: [settle]',
        '    bash: exit 1',
        '',
      ].join('\n')
    );

    const first = runCli(
      ['workflow', 'run', 'provider-scoped', '--cwd', repo, '--no-worktree'],
      archonHome
    );
    // `run` registers providers today, so this half must genuinely execute the node and
    // fail there. Asserting only a non-zero status would also accept the workflow never
    // loading, which would leave nothing for the resume below to be a regression test of.
    expect(first.output).toContain('boom');
    expect(first.status).not.toBe(0);

    // No concurrent writer: the run above is a finished synchronous child.
    const database = new Database(join(archonHome, 'archon.db'), { readonly: true });
    let run: { id: string; status: string } | null;
    try {
      run = database
        .query<
          { id: string; status: string },
          []
        >("SELECT id, status FROM remote_agent_workflow_runs WHERE workflow_name = 'provider-scoped' ORDER BY started_at DESC LIMIT 1")
        .get();
    } finally {
      database.close();
    }
    if (run === null) throw new Error(`no run row was recorded:\n${first.output}`);
    expect(run.status).toBe('failed');

    const resumed = runCli(['workflow', 'resume', run.id, '--cwd', repo], archonHome);

    // With an empty registry the loader drops the workflow for an unknown provider, and the
    // continuation reports the captured source as missing the workflow entirely.
    expect(resumed.output).not.toContain("Unknown provider 'claude'");
    expect(resumed.output).not.toContain('no longer contains that workflow');
    // Positive half: the continuation resolved its workflow and re-executed, reaching the
    // node's own exit status. Asserting only the absence of the two errors above would also
    // pass if the resume failed earlier for some unrelated reason.
    expect(resumed.output).toContain("Bash node 'boom' failed");
    expect(resumed.status).not.toBe(0);
  }, 120_000);
});
