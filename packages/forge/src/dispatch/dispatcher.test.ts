import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { DuplicateHostClaimError, ForgeDispatcher, parseRemoteUrl } from './dispatcher';
import { createGitHubPlugin } from '../github/plugin';
import {
  CHECKS_STATE_OP,
  RESOLVE_OP,
  type ForgeHostsConfig,
  type ForgeOpAuditEvent,
} from '../schemas';
const exec = promisify(execFile);
const track = trackTempRoots();
const fixture = join(import.meta.dir, 'fixtures/well-behaved-plugin.ts');
const ref = { repo: { host: 'fixture.test', path: 'owner/repo' }, number: 42 };
const noDiscovery = async (): Promise<[]> => [];
async function repo(remote?: string): Promise<string> {
  const dir = track(await mkdtemp(join(tmpdir(), 'forge repo ')));
  await exec('git', ['init', '-q', dir]);
  if (remote) await exec('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}
function plugin(settings: object = {}): ForgeHostsConfig[string] {
  return {
    plugin: 'well-behaved',
    command: process.execPath,
    args: [fixture, JSON.stringify(settings)],
  };
}
function dispatcher(
  configuredHosts: ForgeHostsConfig = {},
  env: NodeJS.ProcessEnv = {}
): ForgeDispatcher {
  return new ForgeDispatcher([], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    configuredHosts,
    discoverHome: noDiscovery,
    discoverPath: noDiscovery,
  });
}
describe('real remote resolution', () => {
  it('preserves identity, caches resolution, and never needs credentials or a probe', async () => {
    const cwd = await repo('https://credential@github.com/owner/repo.git');
    const events: ForgeOpAuditEvent[] = [];
    const subject = new ForgeDispatcher([createGitHubPlugin()], {
      cwd,
      env: process.env,
      discoverHome: noDiscovery,
      discoverPath: noDiscovery,
      audit: (event): void => {
        events.push(event);
      },
    });
    const first = await subject.resolve();
    expect(first).toMatchObject({
      kind: 'ok',
      value: { forge: 'github', repo: { host: 'github.com', path: 'owner/repo' } },
    });
    await exec('git', ['remote', 'set-url', 'origin', 'https://different.test/x/y'], { cwd });
    expect(await subject.resolve()).toEqual(first);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('credential');
  });
  it('reads the actual remote after git insteadOf expansion', async () => {
    const cwd = await repo('alias:owner/repo.git');
    await exec('git', ['config', 'url.https://github.com/.insteadOf', 'alias:'], { cwd });
    const subject = new ForgeDispatcher([createGitHubPlugin()], {
      cwd,
      env: process.env,
      discoverHome: noDiscovery,
      discoverPath: noDiscovery,
    });
    expect(await subject.resolve()).toMatchObject({
      kind: 'ok',
      value: { forge: 'github', repo: { host: 'github.com', path: 'owner/repo' } },
    });
  });
  for (const remote of [undefined, 'C:/local/repo', 'https://unknown.test/group/repo.git']) {
    it(`truthfully resolves no forge for ${String(remote)}`, async () => {
      const subject = new ForgeDispatcher([createGitHubPlugin()], {
        cwd: await repo(remote),
        env: process.env,
        discoverHome: noDiscovery,
        discoverPath: noDiscovery,
      });
      expect(await subject.resolve()).toMatchObject({ kind: 'ok', value: { forge: 'none' } });
    });
  }
  it('parses ssh and nested paths and refuses credential or path confusion', () => {
    expect(parseRemoteUrl('ssh://git@gitlab.com/group/sub/repo.git')).toEqual({
      host: 'gitlab.com',
      path: 'group/sub/repo',
    });
    for (const value of [
      'C:/local/repo',
      'not a url',
      'https://host/../repo',
      'https://host/a/b?secret=x',
      'ssh://git@host:2222/a/b',
    ])
      expect(parseRemoteUrl(value)).toBeNull();
  });
});
describe('real plugin boundary', () => {
  it('routes explicitly configured self-hosted identities and forwards only the selected credential', async () => {
    const subject = dispatcher(
      { 'fixture.test': { ...plugin({ behavior: 'env' }), token_env: 'SELECTED_TOKEN' } },
      {
        SELECTED_TOKEN: 'selected-secret',
        UNRELATED_SECRET: 'forbidden',
        INPUTS_MESSAGE: 'private',
        EXAMPLE_TOKEN: 'wrong',
      }
    );
    const result = await subject.checksState(ref);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    const output = result.value.units[0].name;
    expect(output).not.toContain('forbidden');
    expect(output).not.toContain('private');
    expect(output).not.toContain('selected-secret');
    expect(output).not.toContain('wrong');
    expect(output).toContain('ARCHON_FORGE_TOKEN');
    expect(output).toContain('[REDACTED]');
  });
  for (const settings of [{ protocol: 999 }, { behavior: 'stray' }]) {
    it(`refuses handshake ${JSON.stringify(settings)} with a diagnostic before work`, async () => {
      const messages: string[] = [];
      const subject = new ForgeDispatcher([], {
        cwd: process.cwd(),
        env: process.env,
        configuredHosts: { 'fixture.test': plugin(settings) },
        discoverHome: noDiscovery,
        discoverPath: noDiscovery,
        diagnostic: message => {
          messages.push(message);
        },
      });
      await expect(subject.checksState(ref)).rejects.toThrow('did not pass its handshake');
      expect(messages.length).toBeGreaterThan(0);
    });
  }
  it('refuses duplicate host claims from distinct executables', async () => {
    const subject = dispatcher({
      'a.test': plugin({ host: 'duplicate.test' }),
      'b.test': {
        ...plugin({ name: 'second', host: 'duplicate.test' }),
        plugin: 'second',
      },
    });
    await expect(subject.checksState(ref)).rejects.toBeInstanceOf(DuplicateHostClaimError);
  });
  it('refuses unsupported ops before launching a process, independently of credential availability', async () => {
    const marker = join(await repo(), 'marker');
    const subject = dispatcher({ 'fixture.test': plugin({ capabilities: [RESOLVE_OP], marker }) });
    expect(await subject.checksState(ref)).toMatchObject({
      kind: 'error',
      error: { kind: 'unsupported_op', op: CHECKS_STATE_OP },
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  it('missing credentials never launch an operation', async () => {
    const marker = join(await repo(), 'marker');
    const subject = dispatcher({ 'fixture.test': plugin({ marker }) }, { EXAMPLE_TOKEN: '' });
    expect(await subject.checksState(ref)).toMatchObject({
      kind: 'error',
      error: { kind: 'no_credential' },
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  for (const behavior of ['malformed', 'process']) {
    it(`keeps ${behavior} process failure distinct from declared errors and redacts evidence`, async () => {
      const result = await dispatcher(
        { 'fixture.test': plugin({ behavior }) },
        { EXAMPLE_TOKEN: 'no-print-secret' }
      ).checksState(ref);
      expect(result.kind).toBe('process_failure');
      expect(JSON.stringify(result)).not.toContain('no-print-secret');
    });
  }
  it('checks never infers a target from cwd or a branch', async () => {
    expect(
      await dispatcher().checksState({ ...ref, repo: { host: 'unknown.test', path: 'a/b' } })
    ).toMatchObject({ kind: 'error', error: { kind: 'no_plugin_for_host' } });
    expect(await dispatcher().checksState({ ...ref, number: 0 })).toMatchObject({
      kind: 'error',
      error: { kind: 'invalid_request' },
    });
  });
});
