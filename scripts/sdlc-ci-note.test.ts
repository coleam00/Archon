/**
 * Executes the archon-deliver `ci-note` node's actual bash body under real
 * bash, with a fake `gh` on PATH standing in for the process boundary. Every
 * ship/deliver fixture stubs this node entirely (it is a `bash:` node, not an
 * AI turn), so no fixture run ever exercises its shell logic. A defect like
 * `RC=$?` mutated to `RC=$-` (seen once in review) passes every fixture and
 * every type check, and only shows up against a real shell.
 *
 * The script is read out of the workflow file itself via `parseWorkflow`
 * rather than copied here, so this test tracks the authored node instead of
 * a stale duplicate of it.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBashPath } from '@archon/git';
import { spawnSync } from 'node:child_process';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { substituteNodeOutputRefs } from '../packages/workflows/src/dag-executor';
import type { NodeOutput } from '../packages/workflows/src/schemas/workflow-run';

const REPO_ROOT = join(import.meta.dir, '..');
const DELIVER_YAML = join(REPO_ROOT, '.archon/workflows/sdlc/deliver/archon-deliver.yaml');

function readCiNoteScript(): string {
  const content = readFileSync(DELIVER_YAML, 'utf8');
  const result = parseWorkflow(content, 'archon-deliver.yaml');
  if (result.error) {
    throw new Error(`archon-deliver.yaml failed to parse: ${result.error.error}`);
  }
  const corrections = result.workflow.nodes.find(n => n.id === 'corrections');
  if (!corrections || corrections.kind !== 'loop_group') {
    throw new Error("Expected a loop_group node 'corrections' in archon-deliver.yaml");
  }
  const ciNote = corrections.loop_group.nodes.find(n => n.id === 'ci-note');
  if (!ciNote || ciNote.kind !== 'exec') {
    throw new Error("Expected an exec node 'ci-note' with a script body");
  }
  return ciNote.script;
}

const PR_NODE_OUTPUTS = new Map<string, NodeOutput>([
  [
    'pr',
    {
      state: 'completed',
      output: JSON.stringify({ number: 3115 }),
      structuredOutput: { number: 3115 },
    },
  ],
]);

function resolvedCiNoteScript(): string {
  return substituteNodeOutputRefs(readCiNoteScript(), PR_NODE_OUTPUTS, true);
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGhBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ci-note-fake-gh-'));
  tempDirs.push(dir);
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, `#!/bin/sh\n${body}\n`);
  chmodSync(ghPath, 0o755);
  return dir.replace(/\\/g, '/');
}

/** Runs a script body under real bash with the fake gh directory prepended to PATH. */
function runUnderBash(
  script: string,
  fakeBinDir: string
): { stdout: string; status: number | null } {
  const bashPath = resolveBashPath();
  const env = { ...process.env, PATH: `${fakeBinDir};${process.env.PATH}` };
  const result = spawnSync(bashPath, ['-c', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, status: result.status };
}

describe('archon-deliver ci-note bash node', () => {
  test('reports concluded failures and pending checks from a real gh process boundary', () => {
    const fakeBinDir = fakeGhBin(
      [
        'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then',
        '  printf "GREEN\\nRED lint (fail)\\nPENDING\\n"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n')
    );

    const { stdout, status } = runUnderBash(resolvedCiNoteScript(), fakeBinDir);

    expect(status).toBe(0);
    expect(stdout).toContain('Concluded non-green checks:');
    expect(stdout).toContain('- lint (fail)');
    expect(stdout).toContain('1 check(s) still running');
    expect(stdout).not.toContain('No CI evidence is available');
  });

  test('reports no evidence when the gh read fails outright', () => {
    const fakeBinDir = fakeGhBin('exit 1');

    const { stdout, status } = runUnderBash(resolvedCiNoteScript(), fakeBinDir);

    expect(status).toBe(0);
    expect(stdout).toContain(
      'No CI evidence is available for this round (the check read failed or timed out)'
    );
  });

  test('reports no checks when gh succeeds with nothing to report', () => {
    const fakeBinDir = fakeGhBin('exit 0');

    const { stdout, status } = runUnderBash(resolvedCiNoteScript(), fakeBinDir);

    expect(status).toBe(0);
    expect(stdout).toContain('No CI evidence is available for this round (no checks reported)');
  });

  // This is the regression the fixtures cannot see: every ship/deliver fixture stubs
  // the whole ci-note node, so a shell defect in it (RC=$- was submitted in review
  // instead of RC=$?) passed every fixture. Proving THIS test would have caught it
  // means mutating the exact line and showing the failed-read case stops being
  // reported correctly, not asserting against a hand-copied expectation of the bug.
  test('a mutated RC assignment breaks the failed-read case this suite depends on', () => {
    const correctScript = readCiNoteScript();
    expect(correctScript).toContain('RC=$?');
    const mutatedScript = correctScript.replace('RC=$?', 'RC=$-');
    expect(mutatedScript).not.toBe(correctScript);

    const resolvedMutated = substituteNodeOutputRefs(mutatedScript, PR_NODE_OUTPUTS, true);
    const fakeBinDir = fakeGhBin('exit 1');

    const { stdout } = runUnderBash(resolvedMutated, fakeBinDir);

    // $- holds shell option flags (e.g. "himBH"), never an exit status, so the
    // `[ "$RC" -ne 0 ]` comparison fails to evaluate as intended and the script
    // no longer reports the failed-read case the way the correct RC=$? does.
    expect(stdout).not.toContain('the check read failed or timed out');
  });
});
