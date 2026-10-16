/**
 * Paid scope-agent eval. Requires archon on PATH, native provider/forge credentials,
 * and a local PR head: ARCHON_SCOPE_EVAL_PR=https://github.com/owner/repo/pull/123
 * bun run test .archon/scripts/__tests__/review-scope.live.test.ts
 */
import { expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { artifactsOf, getReturns, getRun, launch, waitRun } from '../../workflows/sdlc/.shared/bench';
import { isObject } from '../../workflows/sdlc/.shared/typed';

const track = trackTempRoots();
const repo = join(import.meta.dir, '../../..');
const prUrl = process.env.ARCHON_SCOPE_EVAL_PR;
const command = (args: string[]): string => {
  const result = Bun.spawnSync(args, { cwd: repo });
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

it.skipIf(!prUrl)('the shipped scope agent compares the live PR head and gives an executable rerun command', async () => {
  if (!prUrl) throw new Error('Set ARCHON_SCOPE_EVAL_PR');
  const pr: unknown = JSON.parse(command(['gh', 'pr', 'view', prUrl, '--json', 'headRefOid,headRefName,url']));
  if (!isObject(pr) || typeof pr.headRefOid !== 'string' || typeof pr.headRefName !== 'string' || typeof pr.url !== 'string') {
    throw new Error('PR has no head');
  }
  const { headRefOid, headRefName, url } = pr;
  const root = track(mkdtempSync(join(tmpdir(), 'archon-scope-eval-')));
  const source = join(root, 'source');
  mkdirSync(join(source, '.archon/workflows'), { recursive: true });
  cpSync(join(repo, '.archon/workflows/sdlc'), join(source, '.archon/workflows/sdlc'), { recursive: true });
  const file = join(source, '.archon/workflows/sdlc/review/archon-review.yaml');
  const workflow = Bun.YAML.parse(readFileSync(file, 'utf8'));
  if (!isObject(workflow) || !Array.isArray(workflow.nodes)) throw new Error('No workflow nodes');
  workflow.name = 'archon-review-scope-eval';
  workflow.nodes = workflow.nodes.filter((node: unknown) => isObject(node) && ['mode', 'scope'].includes(String(node.id)));
  workflow.returns = 'scope';
  delete workflow.outcome_field;
  writeFileSync(file, Bun.YAML.stringify(workflow));
  const stale = command(['git', 'rev-parse', `${headRefOid}^`]);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const expectedCommands = [`scope=${url}`, quote(`scope=${url}`), `scope=${quote(url)}`].flatMap(scope =>
    [headRefName, quote(headRefName)].map(branch =>
      `archon workflow run archon-review --input ${scope} --branch ${branch}`));
  for (const [commit, expected] of [[headRefOid, true], [stale, false]] as const) {
    const cwd = join(root, expected ? 'match' : 'mismatch');
    command(['git', 'worktree', 'add', '--detach', cwd, commit]);
    try {
      const id = await launch({
        workflow: 'archon-review-scope-eval', cwd, source, inputs: { scope: url },
        message: 'Problem: verify the shipped PR scope decision. Why: stale heads waste a full review. Why now: protect the head gate. Outcome: establish scope only. Invariants: read-only forge access, no lenses or publication. Acceptance: correct head_matches and an exact rerun command on mismatch. Follow the normal scope instructions.',
      });
      expect(await waitRun(id), id).toBe('completed');
      const result = await getReturns(id);
      expect(result, id).toMatchObject({ head_matches: expected, report: { path: 'review/scope.md' } });
      const report = readFileSync(join(artifactsOf(await getRun(id)), 'review/scope.md'), 'utf8');
      if (!expected) expect(expectedCommands.some(cmd => report.includes(cmd)), report).toBe(true);
    } finally {
      command(['git', 'worktree', 'remove', cwd]);
    }
  }
}, 600_000);
