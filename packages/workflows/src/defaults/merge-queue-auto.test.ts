import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const root = join(import.meta.dir, '../../../..');
const script = join(root, '.archon/workflows/sdlc/merge-queue/scripts/merge-queue.py');
const fixture = join(import.meta.dir, 'fixtures/merge-queue-scenario.py');

describe('bounded automatic queue: real Git, queue and triage validator; simulated model and forge transport', () => {
  let temporary: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'archon-auto-queue-'));
  });
  afterEach(async () => {
    await removeTempTree(temporary);
  });
  for (const scenario of [
    'green',
    'absent_policy',
    'unknown_policy',
    'unsafe_path',
    'malformed_policy',
    'hard_bound',
    'duplicate_policy',
    'symlink_policy',
    'batch_threshold',
    'threshold',
    'cumulative_threshold',
    'policy_changed',
    'risky',
    'large',
    'disagreement',
    'ambiguous_workitem',
    'context_gap',
    'missing_triage',
    'no_external',
    'unknown_required',
    'no_ci_exemption',
    'failed_review',
    'missing_review',
    'no_app_checks',
    'stale_snapshot',
    'changed_evidence',
    'stale_head',
    'stale_base',
    'ci_changed',
    'source_changed',
    'policy_snapshot_changed',
    'input_changed',
  ]) {
    it(
      scenario,
      async () => {
        for (const phase of ['setup', 'exercise']) {
          const child = Bun.spawn(
            [
              process.platform === 'win32' ? 'python' : 'python3',
              fixture,
              script,
              temporary,
              `auto_${scenario}`,
              phase,
            ],
            {
              stdout: 'pipe',
              stderr: 'pipe',
              env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            }
          );
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect({ code, error: stderr || (code ? stdout : '') }).toEqual({ code: 0, error: '' });
        }
      },
      60_000
    );
  }

  for (const mutation of [
    {
      scenario: 'disagreement',
      guard: 'result.get("design_first") is False and result.get("complexity") == "small_bounded"',
      replacement: 'result.get("design_first") is False',
    },
    {
      scenario: 'threshold',
      guard: 'sum(int(a) + int(d) for a, d, _ in entries) <= policy["max_changed_lines"]',
      replacement: 'True',
    },
    {
      scenario: 'policy_changed',
      guard:
        'all(path != AUTO_POLICY_PATH and path != ".archon/merge-queue-policy.json" for _, _, path in entries)',
      replacement: 'True',
    },
  ]) {
    it(`sees ${mutation.scenario} turn red when its consequential guard is reverted`, async () => {
      const source = await readFile(script, 'utf8');
      expect(source.split(mutation.guard)).toHaveLength(2);
      const mutant = join(temporary, 'mutant.py');
      await writeFile(mutant, source.replace(mutation.guard, mutation.replacement));
      for (const phase of ['setup', 'exercise']) {
        const child = Bun.spawn(
          [
            process.platform === 'win32' ? 'python' : 'python3',
            fixture,
            mutant,
            temporary,
            `auto_${mutation.scenario}`,
            phase,
          ],
          { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        if (phase === 'setup') expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        else {
          expect(code).not.toBe(0);
          expect(stderr).toContain('AssertionError:');
          expect(stderr).toContain("'human_required': False");
          expect(stderr).toContain("'kind': 'automatic_policy'");
        }
      }
    }, 60_000);
  }
});
