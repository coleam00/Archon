import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { archonCliLaunchEnv } from '@archon/paths/cli-launch';
import { parseWorkflow } from '../packages/workflows/src/loader';
import type { ChecksState } from '@archon/forge';
import { NON_ASCII_ROUNDTRIP_FIXTURE } from '@archon/forge/conformance';

const root = join(import.meta.dir, '..');
const track = trackTempRoots();
function readCiNoteScript(): string {
  const result = parseWorkflow(
    readFileSync(join(root, '.archon/workflows/sdlc/deliver/archon-deliver.yaml'), 'utf8'),
    'archon-deliver.yaml'
  );
  if (result.error) throw new Error(result.error.error);
  const corrections = result.workflow.nodes.find(n => n.id === 'corrections');
  if (corrections?.kind !== 'loop_group') throw new Error('Missing corrections');
  const node = corrections.loop_group.nodes.find(n => n.id === 'ci-note');
  if (node?.kind !== 'exec' || node.runtime !== 'uv') throw new Error('Missing Python CI note');
  expect(node.with).toEqual({ ref: '$pr.output.ref' });
  return readFileSync(
    join(root, '.archon/workflows/sdlc/deliver/scripts', `${node.script}.py`),
    'utf8'
  );
}
function runNote(state: ChecksState, behavior?: string, script = readCiNoteScript()) {
  const home = track(mkdtempSync(join(tmpdir(), 'ci-note-forge-')));
  writeFileSync(
    join(home, 'forge.json'),
    JSON.stringify({
      hosts: {
        'fixture.test': {
          plugin: 'checks-fixture',
          command: process.execPath,
          args: [
            join(root, 'packages/forge/src/dispatch/fixtures/controlled-checks-plugin.ts'),
            JSON.stringify({ state, sha: 'a'.repeat(40), behavior }),
          ],
        },
      },
    })
  );
  const result = spawnSync('uv', ['run', 'python', '-c', script], {
    cwd: home,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...archonCliLaunchEnv(),
      ARCHON_HOME: home,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      FIXTURE_TOKEN: 'fixture-token',
      INPUTS_REF: JSON.stringify({
        repo: { host: 'fixture.test', path: 'owner/repo' },
        number: 42,
      }),
    },
  });
  if (result.error) throw result.error;
  return result;
}
describe('archon-deliver CI note through the engine forge process boundary', () => {
  test('reports the typed check verdict and keeps audit diagnostics separate', () => {
    const result = runNote('red');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"state": "red"');
    expect(result.stdout).toContain(JSON.stringify(NON_ASCII_ROUNDTRIP_FIXTURE));
    expect(result.stdout).toContain('"head_sha": "' + 'a'.repeat(40));
    expect(result.stderr).toContain('"op":"checks.state"');
    expect(result.stderr).toContain('fixture.test/owner/repo#42');
    expect(result.stdout + result.stderr).not.toContain('fixture-token');
  });
  test('reports optional evidence unavailable when the forge read fails', () => {
    const result = runNote('green', 'failure');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('the engine forge read failed');
  });
  test('preserves an explicit no-checks verdict from the forge', () => {
    const result = runNote('none');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"state": "none"');
    expect(result.stdout).not.toContain('read failed');
  });
  test('mutating the exit-status guard loses the failed-read evidence', () => {
    const script = readCiNoteScript();
    expect(script).toContain('if result.returncode:');
    const result = runNote(
      'green',
      'failure',
      script.replace('if result.returncode:', 'if False:')
    );
    expect(result.stdout).not.toContain('the engine forge read failed');
  });
});
