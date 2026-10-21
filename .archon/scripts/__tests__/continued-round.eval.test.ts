import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitCheckout, PACK, packScriptRunner, PR } from './deliver-checks-harness';
import { trackTempRoots } from './temp-roots';
import { isObject } from '../../workflows/sdlc/.shared/typed';

// Paid outcome evaluation, outside ordinary CI: ARCHON_EVAL_CONTINUED_ROUND=1
// ARCHON_EVAL_ARTIFACTS_DIR=/absolute/path bun run test <this file>.
// ARCHON_EVAL_IMPLEMENT_COMMAND can select a prior prompt for a falsification run.
const enabled = process.env.ARCHON_EVAL_CONTINUED_ROUND === '1';
const track = trackTempRoots();
const { runPackScript } = packScriptRunner();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

for (const stale of [false, true]) {
  test.skipIf(!enabled)(
    `implement ${stale ? 'refuses a stale head before editing' : 'continues and publishes from a queue branch'}`,
    async () => {
      const outputRoot = process.env.ARCHON_EVAL_ARTIFACTS_DIR;
      if (!outputRoot)
        throw new Error('ARCHON_EVAL_ARTIFACTS_DIR is required for the live evaluation');
      const artifacts = resolve(outputRoot, stale ? 'stale' : 'current');
      mkdirSync(artifacts, { recursive: true });
      const checkout = gitCheckout({}, track);
      git(checkout, 'push', '-q', 'upstream', 'feature');
      const head = git(checkout, 'rev-parse', 'feature');
      const branch = 'build/7-continued-round';
      git(checkout, 'checkout', '-q', '-b', branch, 'dev');
      const checked = runPackScript('build-queue/scripts/checkout', {
        cwd: checkout,
        gh: { pr: { headRefOid: head } },
        inputs: { INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: JSON.stringify(PR) },
      });
      expect(checked.code, checked.stderr).toBe(0);
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
      if (stale) git(checkout, 'reset', '--hard', 'dev');
      const before = git(checkout, 'rev-parse', 'HEAD');
      const reflog = git(checkout, 'reflog', '--format=%gs');
      const original = readFileSync(join(checkout, 'a.txt'), 'utf8');
      const bin = track(mkdtempSync(join(tmpdir(), 'archon-implement-eval-')));
      const reads = join(artifacts, 'forge-reads.jsonl');
      writeFileSync(reads, '');
      const pr = {
        headRefName: 'feature',
        headRefOid: head,
        isCrossRepository: false,
        maintainerCanModify: null,
      };
      writeFileSync(
        join(bin, 'gh'),
        `#!${process.execPath}
const args = process.argv.slice(2);
const { appendFileSync } = await import('node:fs');
appendFileSync(${JSON.stringify(reads)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'pr' || args[1] !== 'view' || args[2] !== '42' || !args.includes('${PR.repo.host}/${PR.repo.path}')) process.exit(1);
const pr = ${JSON.stringify(pr)};
const jsonIndex = args.indexOf('--json');
const fields = jsonIndex < 0 ? [] : (args[jsonIndex + 1] ?? '').split(',');
console.log(JSON.stringify(Object.fromEntries(Object.entries(pr).filter(([field]) => fields.includes(field)))));
`,
        { mode: 0o755 }
      );
      const selected = spawnSync(
        join(bin, 'gh'),
        ['pr', 'view', '42', '--repo', `${PR.repo.host}/${PR.repo.path}`, '--json', 'headRefName'],
        { encoding: 'utf8' }
      );
      expect(selected.status, selected.stderr).toBe(0);
      expect(JSON.parse(selected.stdout)).toEqual({ headRefName: 'feature' });
      writeFileSync(reads, '');
      const command = readFileSync(
        process.env.ARCHON_EVAL_IMPLEMENT_COMMAND ?? join(PACK, 'implement/commands/implement.md'),
        'utf8'
      );
      const work = `This build-queue round was launched onto existing same-repository PR 42 in ${PR.repo.host}/${PR.repo.path}. Continue that recorded PR. The PR is already selected; do not merge or adopt another PR.\nProblem: a.txt says feature instead of delivered. This blocks the consumer, and the continued round must correct it now. Desired outcome: a.txt contains exactly delivered followed by a newline. Keep the existing git history and commit the correction on this run's branch. Acceptance: verify the file's exact content and a clean committed checkout. No package manager, tests, lint, type-check or ratchet commands exist in this minimal project. Do not publish; the next node owns publication.`;
      const prompt = command
        .replaceAll('$INPUTS.work', work)
        .replaceAll('$ARGUMENTS', '')
        .replaceAll('$ARTIFACTS_DIR', artifacts)
        .replaceAll('$LOOP_PREV_OUTPUT', '');
      writeFileSync(join(artifacts, 'prompt.md'), prompt);
      const workflow: unknown = Bun.YAML.parse(
        readFileSync(join(PACK, 'implement/archon-implement.yaml'), 'utf8')
      );
      if (!isObject(workflow) || !Array.isArray(workflow.nodes))
        throw new Error('Missing implement workflow nodes');
      const implement: unknown = workflow.nodes.find(
        (node: unknown) => isObject(node) && node.id === 'implement'
      );
      if (!isObject(implement) || !isObject(implement.output_format))
        throw new Error('Missing implement output format');
      const schema = JSON.stringify({ ...implement.output_format, additionalProperties: false });
      const resultFile = join(artifacts, 'events.jsonl');
      const child = Bun.spawn(
        [
          'claude',
          '--print',
          '--dangerously-skip-permissions',
          '--no-session-persistence',
          '--disable-slash-commands',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--output-format',
          'stream-json',
          '--verbose',
          '--json-schema',
          schema,
        ],
        {
          cwd: checkout,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ARCHON_SDLC_FORGE: 'gh',
            ARCHON_CLI_COMMAND: '',
            ARTIFACTS_DIR: artifacts,
          },
          stdin: new Blob([prompt]),
          stdout: Bun.file(resultFile),
          stderr: Bun.file(join(artifacts, 'stderr.log')),
          timeout: 240_000,
        }
      );
      expect(await child.exited).toBe(0);
      const events: unknown[] = readFileSync(resultFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const final = events
        .reverse()
        .find(
          (event): event is { type: 'result'; structured_output: unknown } =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'result' &&
            'structured_output' in event
        );
      const result = final?.structured_output;
      expect(result).toMatchObject({ done: true, green: !stale });
      const calls = readFileSync(reads, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
        .filter(
          (call): call is string[] =>
            Array.isArray(call) && call.every(arg => typeof arg === 'string')
        );
      expect(calls).toContainEqual(
        expect.arrayContaining(['pr', 'view', '42', '--repo', `${PR.repo.host}/${PR.repo.path}`])
      );
      expect(
        calls.map(call => {
          const index = call.indexOf('--json');
          return index < 0 ? [] : (call[index + 1] ?? '').split(',');
        })
      ).toContainEqual(expect.arrayContaining(Object.keys(pr)));
      expect(git(checkout, 'branch', '--show-current')).toBe(branch);
      expect(git(checkout, 'status', '--porcelain')).toBe('');
      if (stale) {
        expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
        expect(git(checkout, 'reflog', '--format=%gs')).toBe(reflog);
        expect(readFileSync(join(checkout, 'a.txt'), 'utf8')).toBe(original);
        return;
      }
      const corrected = git(checkout, 'rev-parse', 'HEAD');
      expect(corrected).not.toBe(head);
      expect(git(checkout, 'rev-parse', 'HEAD^')).toBe(head);
      expect(git(checkout, 'reflog', '--format=%gs').split('\n').slice(1).join('\n')).toBe(reflog);
      expect(readFileSync(join(checkout, 'a.txt'), 'utf8')).toBe('delivered\n');
      const published = runPackScript('pr/scripts/publish-pr', {
        cwd: checkout,
        gh: { pr: { headRefName: 'feature', headRefOid: corrected } },
        inputs: {
          INPUTS_REPO: JSON.stringify(PR.repo),
          INPUTS_HEAD_REPO: JSON.stringify(PR.repo),
          INPUTS_HEAD: branch,
          INPUTS_BRANCH: branch,
          INPUTS_EXISTING: '42',
          INPUTS_PULL_REQUEST: '42',
        },
      });
      expect(published.code, published.stderr).toBe(0);
      expect(JSON.parse(published.stdout)).toMatchObject({
        number: 42,
        head: 'feature',
        head_revision: corrected,
      });
      expect(git(checkout, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(
        corrected
      );
      expect(git(checkout, 'ls-remote', 'upstream', `refs/heads/${branch}`)).toBe('');
    },
    300_000
  );
}
