import { describe, it, expect } from 'bun:test';
import { join } from 'path';

// RED-PHASE E2E SCAFFOLD (SKIPPED) — Story a1.2 first-party consumer surface.
//
// The operator observes story-input resolution through the CLI they actually run:
//   - `bun run cli workflow run bmad-dev-story-with-tea-fix-loop-v2 ""`      (missing)
//   - `bun run cli workflow run bmad-dev-story-with-tea-fix-loop-v2 nope-xxx` (invalid)
//   - `bun run cli workflow run bmad-dev-story-with-tea-fix-loop-v2 a1`       (ambiguous)
//         → each MUST exit non-zero at the resolve-story-input node, BEFORE any AI
//           provider is invoked (fail-fast). This is credential-free: resolution is
//           a bash node that runs first, so these cases need no provider keys.
//   - a valid single-match ref → run proceeds PAST resolution (first AI node starts).
//
// These are `test.skip` because this repo has no subprocess CLI e2e harness yet
// (existing CLI tests call command functions in-process with mocked discovery),
// and the resolve-story-input node does not exist yet. The in-process proxies for
// AC #3/#5 are already executable RED tests in
// packages/workflows/src/defaults/v2-story-input-resolution.test.ts (BASH level).
//
// TO ACTIVATE: implement `runCli` with a Bun.spawn wrapper that shells
// `bun src/cli.ts <args>` from a BMAD-enabled fixture checkout and returns
// { stdout, stderr, exitCode }, then drop `.skip`. Run against a temp repo that
// has _bmad-output/implementation-artifacts/sprint-status.yaml + the required
// .agents/skills/* so prepare-bmad-state passes and resolution is what gates.

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const V2 = 'bmad-dev-story-with-tea-fix-loop-v2';

// Placeholder seam — implement with Bun.spawn when activating (see header).
declare function runCli(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }>;

describe('CLI consumer surface — v2 story-input resolution (Story a1.2)', () => {
  it.skip('E2E-A3-1 [P0] `workflow run <v2> ""` (missing input) exits non-zero, no AI provider invoked', async () => {
    const { stderr, stdout, exitCode } = await runCli(['workflow', 'run', V2, ''], REPO_ROOT);
    expect(exitCode).not.toBe(0);
    // Fail-fast happened at resolution, before dev-story/tea-* streamed anything.
    expect(`${stdout}${stderr}`.toLowerCase()).toContain('missing');
  });

  it.skip('E2E-A3-2 [P0] `workflow run <v2> <unknown-ref>` exits non-zero (invalid)', async () => {
    const { exitCode } = await runCli(['workflow', 'run', V2, 'no-such-story-xyz'], REPO_ROOT);
    expect(exitCode).not.toBe(0);
  });

  it.skip('E2E-A3-3 [P0] `workflow run <v2> a1` exits non-zero (ambiguous: a1-1 AND a1-2)', async () => {
    const { exitCode } = await runCli(['workflow', 'run', V2, 'a1'], REPO_ROOT);
    expect(exitCode).not.toBe(0);
  });

  it.skip('E2E-A2-1 [P1] `workflow run <v2> <valid-key>` proceeds past resolution (resolve node succeeds)', async () => {
    // With mocked/echo providers or --detach, the run must get BEYOND resolution:
    // resolve-story-input completes and dev-story starts. Assert no resolution error
    // in output and a non-failure exit at the resolution boundary.
    const { stdout, stderr } = await runCli(
      ['workflow', 'run', V2, 'a1-2-preserve-story-input-resolution', '--detach'],
      REPO_ROOT
    );
    expect(`${stdout}${stderr}`.toLowerCase()).not.toContain('missing required story');
    expect(`${stdout}${stderr}`.toLowerCase()).not.toContain('no story matched');
  });
});
