import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const ANSWERED = forgeOperation('pr.view', null);
const ARCHON_HOME = join(tmpdir(), 'archon-home-elsewhere');
const SETUP = [
  'archon plugin add coleam00/Archon/plugins/forge-github',
  'GH_TOKEN',
  join(ARCHON_HOME, '.env'),
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
  return runPackScript('deliver/scripts/forge-check', {
    cwd,
    ...rest,
    inputs: { ARCHON_HOME, ...rest.inputs },
  });
}

describe('forge-check refuses a run whose forge source cannot act', () => {
  it('reads through the forge plugin when no source is selected', () => {
    const run = check({ forge: { kind: 'fake', response: ANSWERED } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'forge' });
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([expect.stringContaining('forge pr.view')]);
    expect(JSON.parse(run.forgeRequests[0] ?? '')).toEqual({
      selector: { kind: 'head', repo: PR.repo, headRepo: PR.repo, head: 'archon-forge-check' },
    });
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

  it('names the repository-config gh switch when the host published no CLI command', () => {
    const run = check({ forge: { kind: 'no-host' } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ARCHON_CLI_COMMAND is not set');
    // A container execution, the host that publishes no command, never reads ~/.archon/.env.
    expect(run.stderr).toContain("`env: { ARCHON_SDLC_FORGE: gh }` in the repository's `.archon/config.yaml`");
  });

  it('names the update and the gh switch when the installed plugin lacks the read', () => {
    const run = check({
      forge: { kind: 'fake', response: refusal('unsupported_op', 'plugin github does not support pr.view') },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('archon plugin update coleam00/Archon/plugins/forge-github');
    expect(run.stderr).toContain('may not support this operation either');
    expect(run.stderr).toContain('ARCHON_SDLC_FORGE=gh');
  });

  it('passes when a mirror on an unclaimed host sits beside a remote that answers', () => {
    const run = check({
      mirror: true,
      forge: { kind: 'fake', response: [ANSWERED, refusal('no_plugin_for_host', 'no forge plugin claims mirror.example.com')] },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(2);
    expect(run.stderr).toContain('forge source answered for ghe.example.com/example/repo');
    expect(run.stderr).toContain('mirror.example.com/example/repo: forge pr.view failed');
  });

  it('checks gh authentication, never the forge, when gh is selected', () => {
    const passed = check({ source: 'gh' });
    expect({ code: passed.code, stderr: passed.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(passed.stdout)).toEqual({ source: 'gh' });
    expect(passed.gh).toEqual(['auth status --active --hostname ghe.example.com']);
    expect(passed.forge).toEqual([]);

    const refused = check({ source: 'gh', gh: { authFail: 'You are not logged into any GitHub hosts.' } });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('You are not logged into any GitHub hosts.');
    expect(refused.forge).toEqual([]);
  });

  it('passes gh when one remote host is authenticated and another is not', () => {
    const run = check({ source: 'gh', mirror: true, gh: { authFail: { 'ghe.example.com': 'token expired' } } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.gh).toEqual(['auth status --active --hostname ghe.example.com', 'auth status --active --hostname mirror.example.com']);
  });

  it('refuses gh when GH_TOKEN and GITHUB_TOKEN are empty, rather than using the host login', () => {
    const run = check({ source: 'gh', inputs: { GH_TOKEN: '', GITHUB_TOKEN: '' } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('`GH_TOKEN=` line');
    expect(run.stderr).toContain('archon auth github');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });

  it('passes gh when GH_TOKEN is empty but GITHUB_TOKEN authenticates it', () => {
    const run = check({ source: 'gh', inputs: { GH_TOKEN: '', GITHUB_TOKEN: 'ghp_example' } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.gh).toEqual(['auth status --active --hostname ghe.example.com']);
  });

  it('refuses an unknown source, naming both values', () => {
    const run = check({ source: 'gitlab' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ARCHON_SDLC_FORGE must be "forge" (the default) or "gh", not "gitlab"');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });
});

describe('forge-check with the GitHub plugin release v0.11.1 shipped', () => {
  const released = {
    kind: 'home',
    config: {
      scanPath: false,
      plugins: [
        {
          plugin: 'github',
          command: process.execPath,
          args: ['--no-env-file', join(import.meta.dir, 'fixtures/released-github-plugin.ts')],
        },
      ],
    },
  } as const;
  const withToken = (GH_TOKEN: string) =>
    check({ forge: released, inputs: { GH_TOKEN, GITHUB_TOKEN: '' } });

  it('passes when the plugin accepts the token', () => {
    const run = withToken('accepted');
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'forge' });
    expect(run.stderr).toContain('write access');
  });

  it('refuses without a token, naming the setup', () => {
    const run = withToken('');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('credential environment GH_TOKEN or GITHUB_TOKEN is not set');
    expect(run.stderr).toContain('archon plugin add coleam00/Archon/plugins/forge-github');
  });

  it('refuses a token the forge rejects', () => {
    const run = withToken('revoked');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Bad credentials');
  });
});
