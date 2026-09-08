import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { archonCliLaunchEnv } from '@archon/paths/cli-launch';
import { CHECKS, type ChecksState } from '@archon/forge';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
const track = trackTempRoots();
const root = resolve(import.meta.dir, '../../..');
const parsed = parseWorkflow(
  readFileSync(join(root, '.archon/workflows/sdlc/deliver/archon-deliver.yaml'), 'utf8'),
  'archon-deliver.yaml'
);
if (!parsed.workflow) throw new Error(parsed.error.error);
const node = parsed.workflow.nodes.find(node => node.id === 'flip-ready');
if (node?.kind !== 'exec' || node.runtime !== 'uv') throw new Error('Missing ready preflight');
const script = join(root, '.archon/workflows/sdlc/deliver/scripts', `${node.script}.py`);
function runFlip(
  state: ChecksState,
  malformed = false,
  required?: ChecksState,
  moved = false
): { result: SpawnSyncReturns<string>; ready: boolean } {
  const temp = track(mkdtempSync(join(tmpdir(), 'forge flip ')));
  const home = join(temp, 'home');
  mkdirSync(home);
  function git(args: string[]): string {
    const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-q', '-b', 'feature']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const sha = git(['rev-parse', 'HEAD']);
  const marker = join(temp, 'ready');
  writeFileSync(
    join(home, 'forge.json'),
    JSON.stringify({
      hosts: {
        'fixture.test': {
          plugin: 'checks-fixture',
          command: process.execPath,
          args: [
            join(root, 'packages/forge/src/dispatch/fixtures/controlled-checks-plugin.ts'),
            JSON.stringify({
              state,
              required,
              sha: moved ? 'a'.repeat(40) : sha,
              behavior: malformed ? 'malformed' : '',
              marker,
            }),
          ],
        },
      },
    })
  );
  const repo = { host: 'fixture.test', path: 'owner/repo' };
  const result = spawnSync('uv', ['run', 'python', script], {
    cwd: temp,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...archonCliLaunchEnv(),
      ARCHON_HOME: home,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      FIXTURE_TOKEN: 'fixture-token',
      INPUTS_PR: JSON.stringify({
        ref: { repo, number: 42 },
        head_repo: repo,
        head: 'feature',
        base: 'dev',
      }),
      INPUTS_OPERATION: 'ready',
      INPUTS_BODY: '',
    },
  });
  if (result.error) throw result.error;
  return { result, ready: existsSync(marker) };
}
describe('deliver preflight through the engine forge boundary', () => {
  for (const state of [CHECKS.green, CHECKS.none])
    it(`permits observed ${state}`, () => {
      const { result, ready } = runFlip(state);
      expect(result.status).toBe(0);
      expect(ready).toBe(true);
      expect(result.stdout.trim()).toBe('https://fixture.test/owner/repo/pull/42');
      expect(result.stdout + result.stderr).not.toContain('fixture-token');
    });
  for (const state of [CHECKS.pending, CHECKS.red, CHECKS.gated, CHECKS.unknown])
    it(`refuses ${state} before any ready write`, () => {
      const { result, ready } = runFlip(state);
      expect(result.status).not.toBe(0);
      expect(ready).toBe(false);
      expect(result.stderr).toContain('Ready refused');
    });
  it('a malformed plugin response cannot become no checks', () => {
    const { result, ready } = runFlip(CHECKS.green, true);
    expect(result.status).not.toBe(0);
    expect(ready).toBe(false);
    expect(result.stderr).toContain('Forge publication refused');
  });
  it.each([
    { state: CHECKS.red, required: CHECKS.green, ready: true },
    { state: CHECKS.green, required: CHECKS.red, ready: false },
  ])(
    'uses required $required checks when the aggregate is $state',
    ({ state, required, ready }) => {
      expect(runFlip(state, false, required).ready).toBe(ready);
    }
  );
  it('refuses a different checked head', () => {
    const moved = runFlip(CHECKS.green, false, undefined, true);
    expect(moved.ready).toBe(false);
    expect(moved.result.stderr).toContain('Ready refused');
  });
});
