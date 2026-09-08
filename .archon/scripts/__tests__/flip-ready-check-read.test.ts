import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { archonCliLaunchEnv } from '@archon/paths/cli-launch';
import { resolveBashPath } from '@archon/git';
import { CHECKS, type ChecksState } from '@archon/forge';
const track = trackTempRoots();
const root = resolve(import.meta.dir, '../../..');
const workflow = Bun.YAML.parse(readFileSync(join(root, '.archon/workflows/sdlc/deliver/archon-deliver.yaml'), 'utf8')) as { nodes: { id: string; bash?: string }[] };
function runFlip(state: ChecksState, malformed = false): { result: SpawnSyncReturns<string>; ready: boolean } {
  const temp = track(mkdtempSync(join(tmpdir(), 'forge flip ')));
  const bin = join(temp, 'bin'); mkdirSync(bin);
  const home = join(temp, 'home'); mkdirSync(home);
  const marker = join(temp, 'ready').replace(/\\/g, '/');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr ready" ]; then touch '${marker}'; exit 0; fi\ncase "$*" in\n *'--json isDraft'*) echo false;;\n *'--json url'*) echo https://github.com/owner/repo/pull/42;;\n *) exit 99;;\nesac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(home, 'forge.json'), JSON.stringify({ hosts: { 'fixture.test': {
    plugin: 'well-behaved', command: process.execPath,
    args: [join(root, 'packages/forge/src/dispatch/fixtures/well-behaved-plugin.ts'), JSON.stringify({ state, behavior: malformed ? 'malformed' : '' })],
  } } }));
  const node = workflow.nodes.find(node => node.id === 'flip-ready');
  if (!node?.bash) throw new Error('Missing ready preflight');
  const body = node.bash.replaceAll('$forge-repo.output.path', 'owner/repo')
    .replaceAll('$forge-repo.output', "'{\"host\":\"fixture.test\",\"path\":\"owner/repo\"}'").replaceAll('$pr.output.number', '42');
  const result = spawnSync(resolveBashPath(), ['-c', body], { cwd: temp, encoding: 'utf8', env: {
    ...process.env, ...archonCliLaunchEnv(), ARCHON_HOME: home, ARCHON_TELEMETRY_DISABLED: '1', EXAMPLE_TOKEN: 'fixture-token',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  } });
  return { result, ready: existsSync(marker) };
}
describe('deliver preflight through the engine forge boundary', () => {
  for (const state of [CHECKS.green, CHECKS.none]) it(`permits observed ${state}`, () => {
    const { result, ready } = runFlip(state);
    expect(result.status).toBe(0); expect(ready).toBe(true);
    expect(result.stdout.trim()).toBe('https://github.com/owner/repo/pull/42');
  });
  for (const state of [CHECKS.pending, CHECKS.red, CHECKS.gated, CHECKS.unknown]) it(`refuses ${state} before any ready write`, () => {
    const { result, ready } = runFlip(state);
    expect(result.status).not.toBe(0); expect(ready).toBe(false); expect(result.stderr).toContain('flip-ready');
  });
  it('a malformed plugin response cannot become no checks', () => {
    const { result, ready } = runFlip(CHECKS.green, true);
    expect(result.status).not.toBe(0); expect(ready).toBe(false); expect(result.stderr).toContain('flip-ready');
  });
});
