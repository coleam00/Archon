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
import { cliForgeMetadataRequestSchema } from '../../../packages/forge/src/cli-response';
import { REQUIRED_FORGE_OPERATIONS } from '../../workflows/sdlc/.shared/forge-check';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

const ANSWERED = forgeOperation('pr.view', null);
const ARCHON_HOME = join(tmpdir(), 'archon-home-elsewhere');
const SETUP = [
  'archon plugin add coleam00/Archon/plugins/forge-github',
  'GH_TOKEN',
  '~/.archon/.env',
  'ARCHON_HOME/.env',
  '/.archon/.env',
  'archon auth github',
  'ARCHON_SDLC_FORGE=gh',
];

function refusal(kind: string, message: string): string {
  return JSON.stringify({ operationId: 'op-labels', ok: false, error: { kind, message } });
}

function check(
  options: ScriptOptions & {
    mirror?: boolean;
    capabilities?: readonly string[];
    entry?: string;
  } = {}
) {
  const { mirror, entry = 'deliver', capabilities = REQUIRED_FORGE_OPERATIONS, ...rest } = options;
  if (rest.forge?.kind === 'fake' && rest.forge.response) {
    const reads =
      typeof rest.forge.response === 'string' ? [rest.forge.response] : rest.forge.response;
    rest.forge = {
      ...rest.forge,
      response: reads.flatMap(read => [forgeOperation('metadata', { capabilities }), read]),
    };
  }
  const cwd = gitCheckout({}, trackTempRoot);
  if (mirror === true) {
    spawnSync('git', ['remote', 'add', 'mirror', 'https://mirror.example.com/example/repo.git'], {
      cwd,
    });
  }
  return runPackScript(`${entry}/scripts/forge-check`, {
    cwd,
    source: 'forge',
    ...rest,
    inputs: { ARCHON_HOME, ...rest.inputs },
  });
}

describe('forge-check refuses a run whose forge source cannot act', () => {
  it('uses gh when no source is selected', () => {
    const run = check({ source: '' });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'gh' });
    expect(run.forge).toEqual([]);
  });

  it.each(['deliver', 'pr', 'ship', 'upkeep'])('emits the selected forge source from %s', entry => {
    const run = check({ entry, forge: { kind: 'fake', response: ANSWERED } });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'forge' });
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([
      expect.stringContaining('forge metadata'),
      expect.stringContaining('forge pr.view'),
    ]);
    expect(JSON.parse(run.forgeRequests[1] ?? '')).toEqual({
      selector: { kind: 'head', repo: PR.repo, headRepo: PR.repo, head: 'archon-forge-check' },
    });
  });

  it.each(['gh', 'forge'])('%s metadata requests conform to the CLI host input', source => {
    const run = check({
      source,
      gh: { authFail: 'logged out' },
      forge: { kind: 'fake', response: ANSWERED },
    });
    expect(run.code).toBe(source === 'forge' ? 0 : 1);
    expect(run.forge[0]).toContain('forge metadata');
    const request = cliForgeMetadataRequestSchema.parse({
      ...JSON.parse(run.forgeRequests[0] ?? ''),
      op: 'metadata',
      operationId: 'cli-operation',
    });
    expect(request.host).toBe(PR.repo.host);
    if (source === 'gh') expect(run.stderr).toContain('ARCHON_SDLC_FORGE=forge');
  });

  it('accepts a capable installed plugin through host discovery and authenticated dispatch', () => {
    const plugin = `
      if (process.argv.includes('metadata')) {
        console.log(JSON.stringify({protocol: 1, name: 'github', version: 'test', forge: 'github',
          hosts: ['ghe.example.com'], capabilities: ${JSON.stringify(REQUIRED_FORGE_OPERATIONS)}, token_env: ['GH_TOKEN']}));
      } else {
        const request = await Bun.stdin.json();
        if (request.op !== 'pr.view' || process.env.ARCHON_FORGE_TOKEN !== 'accepted') throw new Error('invalid preflight read');
        console.log(JSON.stringify({operationId: request.operationId, ok: true, result: {op: 'pr.view', value: null}}));
      }
    `;
    const run = check({
      forge: {
        kind: 'home',
        config: {
          scanPath: false,
          plugins: [
            {
              plugin: 'github',
              command: process.execPath,
              args: ['--no-env-file', '-e', plugin],
            },
          ],
        },
      },
      inputs: { GH_TOKEN: 'accepted' },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toEqual({ source: 'forge' });
    expect(run.stderr).toContain('Read access is verified; write access is not');
    expect(run.stderr).toContain('source: GH_TOKEN');
    expect(run.gh).toEqual([]);
  });

  it('refuses a plugin missing checks.state before the authenticated read', () => {
    const run = check({
      forge: { kind: 'fake', response: ANSWERED },
      capabilities: REQUIRED_FORGE_OPERATIONS.filter(op => op !== 'checks.state'),
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('missing: checks.state');
    expect(run.forge).toHaveLength(1);
    expect(run.forge[0]).toContain('forge metadata');
    expect(run.gh).toEqual([]);
  });

  it('names both setup steps when no plugin claims the host', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('no_plugin_for_host', 'no forge plugin claims ghe.example.com'),
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no forge plugin claims ghe.example.com');
    for (const step of SETUP) expect(run.stderr).toContain(step);
  });

  it('names both setup steps when the credential is missing', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('no_credential', 'credential environment GH_TOKEN is not set'),
      },
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
    expect(run.stderr).toContain(
      "`env: { ARCHON_SDLC_FORGE: gh }` in the repository's `.archon/config.yaml`"
    );
  });

  it('names the update and the gh switch when the installed plugin lacks the read', () => {
    const run = check({
      forge: {
        kind: 'fake',
        response: refusal('unsupported_op', 'plugin github does not support pr.view'),
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('archon plugin update coleam00/Archon/plugins/forge-github');
    expect(run.stderr).toContain('may not support this operation either');
    expect(run.stderr).toContain('ARCHON_SDLC_FORGE=gh');
  });

  it('passes when a mirror on an unclaimed host sits beside a remote that answers', () => {
    const run = check({
      mirror: true,
      forge: {
        kind: 'fake',
        response: [
          ANSWERED,
          refusal('no_plugin_for_host', 'no forge plugin claims mirror.example.com'),
        ],
      },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(4);
    expect(run.stderr).toContain('forge source answered for ghe.example.com/example/repo');
    expect(run.stderr).toContain('mirror.example.com/example/repo: forge pr.view failed');
  });

  it('checks gh authentication and inspects plugin metadata only for a refusal remedy', () => {
    const passed = check({ source: 'gh' });
    expect({ code: passed.code, stderr: passed.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(passed.stdout)).toEqual({ source: 'gh' });
    expect(passed.gh).toEqual(['auth status --active --hostname ghe.example.com']);
    expect(passed.forge).toEqual([]);

    const refused = check({
      source: 'gh',
      gh: { authFail: 'You are not logged into any GitHub hosts.' },
    });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('You are not logged into any GitHub hosts.');
    expect(refused.forge).toEqual([expect.stringContaining('forge metadata')]);
    expect(refused.stderr).toContain('GH_TOKEN');
    expect(refused.stderr).not.toContain('ARCHON_SDLC_FORGE=forge');
  });

  it.each([true, false])(
    'offers the forge alternative only with complete installed capabilities (%s)',
    compatible => {
      const run = check({
        source: 'gh',
        gh: { authFail: 'logged out' },
        forge: { kind: 'fake', response: ANSWERED },
        capabilities: compatible ? REQUIRED_FORGE_OPERATIONS : ['pr.view'],
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('GH_TOKEN');
      expect(run.stderr.includes('ARCHON_SDLC_FORGE=forge')).toBe(compatible);
      expect(run.forge).toEqual([expect.stringContaining('forge metadata')]);
    }
  );

  it('passes gh when one remote host is authenticated and another is not', () => {
    const run = check({
      source: 'gh',
      mirror: true,
      gh: { authFail: { 'ghe.example.com': 'token expired' } },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.stderr).toContain('ghe.example.com: token expired');
    expect(run.stderr).toContain('gh authenticated for mirror.example.com');
    expect(run.gh).toEqual([
      'auth status --active --hostname ghe.example.com',
      'auth status --active --hostname mirror.example.com',
    ]);
  });

  it.each(['', 'gh'])(
    'refuses default or explicit gh (%s) when per-user credentials are scrubbed',
    source => {
      const run = check({
        source,
        inputs: {
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          GH_ENTERPRISE_TOKEN: '',
          GITHUB_ENTERPRISE_TOKEN: '',
        },
      });
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('`GH_ENTERPRISE_TOKEN=` line');
      expect(run.stderr).toContain('archon auth github');
      expect(run.gh).toEqual([]);
      expect(run.forge).toEqual([expect.stringContaining('forge metadata')]);
    }
  );

  it('passes gh when GH_TOKEN is empty but the Enterprise token authenticates its host', () => {
    const run = check({
      source: 'gh',
      inputs: { GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: 'ghp_example' },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.gh).toEqual(['auth status --active --hostname ghe.example.com']);
  });

  it('refuses an unknown source, naming both values', () => {
    const run = check({ source: 'gitlab' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(
      'ARCHON_SDLC_FORGE must be "gh" (the default) or "forge", not "gitlab"'
    );
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

  it('refuses the released plugin missing pack operations before its first mutation', () => {
    const run = withToken('accepted');
    expect(run.code).not.toBe(0);
    for (const operation of [
      'pr.draft',
      'checks.rerun',
      'repo.labels.list',
      'repo.label.ensure',
      'workitem.labels.set',
      'workitem.comment.upsert',
      'workitem.close',
    ])
      expect(run.stderr).toContain(operation);
    expect(run.stderr).toContain('ARCHON_SDLC_FORGE=gh');
  });
});
