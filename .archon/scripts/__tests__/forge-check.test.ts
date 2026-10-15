import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  forgeOperation,
  gitCheckout,
  packScriptRunner,
  PR,
  type ScriptOptions,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

const LABELS = forgeOperation('repo.labels.list', { repo: PR.repo, labels: [{ name: 'area' }] });
const SETUP = [
  'archon plugin add coleam00/Archon/plugins/forge-github',
  'GH_TOKEN',
  '~/.archon/.env',
  'archon auth github',
  'ARCHON_SDLC_FORGE=gh',
];

function refusal(kind: string, message: string): string {
  return JSON.stringify({ operationId: 'op-labels', ok: false, error: { kind, message } });
}

function check(options: ScriptOptions & { mirror?: boolean } = {}) {
  const { mirror, ...rest } = options;
  const cwd = gitCheckout({}, trackTempRoot);
  if (mirror === true) {
    spawnSync('git', ['remote', 'add', 'mirror', 'https://mirror.example.com/example/repo.git'], { cwd });
  }
  return runPackScript('deliver/scripts/forge-check', { cwd, ...rest });
}

describe('forge-check refuses a run whose forge source cannot act', () => {
  it('reads through the forge plugin when no source is selected', () => {
    const run = check({ forge: { kind: 'fake', response: LABELS } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'forge' });
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([expect.stringContaining('forge repo.labels.list')]);
    expect(JSON.parse(run.forgeRequests[0] ?? '')).toEqual({ repo: PR.repo });
  });

  it('names both setup steps when no plugin claims the host', () => {
    const run = check({
      forge: { kind: 'fake', response: refusal('no_plugin_for_host', 'no forge plugin claims ghe.example.com') },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no forge plugin claims ghe.example.com');
    for (const step of SETUP) expect(run.stderr).toContain(step);
  });

  it('names both setup steps when the credential is missing', () => {
    const run = check({
      forge: { kind: 'fake', response: refusal('no_credential', 'credential environment GH_TOKEN is not set') },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('credential environment GH_TOKEN is not set');
    for (const step of SETUP) expect(run.stderr).toContain(step);
  });

  it('names the update when the installed plugin lacks the read', () => {
    const run = check({
      forge: { kind: 'fake', response: refusal('unsupported_op', 'plugin github does not support repo.labels.list') },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('archon plugin update coleam00/Archon/plugins/forge-github');
  });

  it('passes when a mirror on an unclaimed host sits beside a remote that answers', () => {
    const run = check({
      mirror: true,
      forge: { kind: 'fake', response: [LABELS, refusal('no_plugin_for_host', 'no forge plugin claims mirror.example.com')] },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(2);
    expect(run.stderr).toContain('forge source answered for ghe.example.com/example/repo');
    expect(run.stderr).toContain('mirror.example.com/example/repo: forge repo.labels.list failed');
  });

  it('checks gh authentication, never the forge, when gh is selected', () => {
    const passed = check({ source: 'gh' });
    expect({ code: passed.code, stderr: passed.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(passed.stdout)).toEqual({ source: 'gh' });
    expect(passed.gh).toEqual(['auth status']);
    expect(passed.forge).toEqual([]);

    const refused = check({ source: 'gh', gh: { authFail: 'You are not logged into any GitHub hosts.' } });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('You are not logged into any GitHub hosts.');
    expect(refused.forge).toEqual([]);
  });

  it('refuses gh when GH_TOKEN is empty, rather than using the host login', () => {
    const run = check({ source: 'gh', inputs: { GH_TOKEN: '' } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('`GH_TOKEN=` line');
    expect(run.stderr).toContain('archon auth github');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });

  it('refuses an unknown source, naming both values', () => {
    const run = check({ source: 'gitlab' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ARCHON_SDLC_FORGE must be "forge" (the default) or "gh", not "gitlab"');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });
});
