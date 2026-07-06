import { describe, it, expect } from 'bun:test';
import { join } from 'path';

// RED-PHASE E2E SCAFFOLD (SKIPPED) — Story a1.1 first-party consumer surface.
//
// AC2/AC3 are ultimately observed through the CLI a real operator runs:
//   - `bun run cli workflow list [--json]`  → v2 appears, v1 unchanged (AC2)
//   - `bun run cli validate workflows bmad-dev-story-with-tea-fix-loop-v2 --json`
//        → summary.valid >= 1, summary.errors == 0 (AC3)
//
// These are `test.skip` because this repo has no subprocess CLI e2e harness yet
// (existing CLI tests call command functions in-process with mocked discovery).
// The in-process proxies for these ACs are already executable RED tests in
// packages/workflows/src/defaults/v2-workflow-baseline.test.ts (discovery +
// parseWorkflow). Activate these by spawning the CLI against the real repo:
// replace `runCli` below with a Bun.spawn wrapper that shells `bun src/cli.ts`
// from REPO_ROOT and returns { stdout, exitCode }, then drop `.skip`.

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const V1 = 'bmad-dev-story-with-tea-fix-loop';
const V2 = 'bmad-dev-story-with-tea-fix-loop-v2';

// Placeholder seam — implement with Bun.spawn when activating (see header).
declare function runCli(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }>;

describe('CLI consumer surface — v2 workflow (Story a1.1)', () => {
  it.skip('S2.4 [P1] `workflow list --json` shows v2 and still shows v1', async () => {
    const { stdout, exitCode } = await runCli(['workflow', 'list', '--json'], REPO_ROOT);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { workflows: Array<{ name: string }> };
    const names = parsed.workflows.map(w => w.name);
    expect(names).toContain(V2);
    expect(names).toContain(V1);
  });

  it.skip('S3.4 [P1] `validate workflows <v2> --json` reports valid with zero errors', async () => {
    const { stdout, exitCode } = await runCli(['validate', 'workflows', V2, '--json'], REPO_ROOT);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { summary: { valid: number; errors: number } };
    expect(parsed.summary.valid).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.errors).toBe(0);
  });
});
