import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { disposeWorkflowSource } from '@archon/workflows/run-source';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { Codebase } from '../schemas/codebase';
import { captureBindingDefinitions, refuseWorktreeAfterInPlace } from './binding-definitions';
import { DefinitionSourceError } from './definition-source';
import type { WorkflowHost } from './host-store';

const track = trackTempRoots();

const workflow = (fields: Partial<ResolvedWorkflow>) =>
  ({ name: 'stage', ...fields }) as ResolvedWorkflow;

describe('a binding start whose base workflow runs in place', () => {
  test("keeps the checkout's copy when it runs in place too", () => {
    const inPlace = workflow({ worktree: { enabled: false } });
    expect(refuseWorktreeAfterInPlace(inPlace)).toBe(inPlace);
  });

  test("refuses when the checkout's copy would get a worktree", () => {
    expect(() => refuseWorktreeAfterInPlace(workflow({}))).toThrow(
      "Workflow 'stage' runs in place"
    );
    expect(() => refuseWorktreeAfterInPlace(workflow({ worktree: { enabled: true } }))).toThrow(
      'start is refused'
    );
  });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/**
 * A remote that serves only the run-as user's token, standing in for a private GitHub
 * repository: its upload-pack, which serves every remote read (ls-remote and fetch),
 * records the GH_TOKEN each read ran with and refuses any other. git strips
 * GIT_CONFIG_PARAMETERS from a local upload-pack's env, so the helper is not visible here;
 * the real-git proof that the run-as user's env makes git present the token over HTTPS is
 * in github-token-policy.test.ts.
 */
function privateProject(): { checkout: string; reads: () => string[] } {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-binding-fetch-'))));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '--initial-branch=dev', remote);
  const checkout = join(root, 'checkout');
  git(root, 'clone', '-q', remote, checkout);
  mkdirSync(join(checkout, '.archon', 'workflows'), { recursive: true });
  writeFileSync(join(checkout, '.archon', 'workflows', 'stage.yaml'), 'name: stage\n');
  git(checkout, 'add', '-A');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git(checkout, 'push', '-q', 'origin', 'dev');
  const record = join(root, 'remote-reads');
  writeFileSync(record, '');
  const uploadPack = join(root, 'upload-pack');
  writeFileSync(
    uploadPack,
    `#!/bin/sh\nprintf 'token=%s\\n' "$GH_TOKEN" >> '${record}'\n` +
      `[ "$GH_TOKEN" = ghu_runas ] || { echo 'repository not found' >&2; exit 1; }\n` +
      'exec git-upload-pack "$@"\n'
  );
  chmodSync(uploadPack, 0o755);
  git(checkout, 'config', 'remote.origin.uploadpack', uploadPack);
  return { checkout, reads: () => readFileSync(record, 'utf8').split('\n').filter(Boolean) };
}

describe('a binding start fired from a scrubbed node', () => {
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const host = {
    deps: {
      isPerUserGitHubEnabled: () => true,
      getUserGithubToken: async (userId: string) =>
        userId === 'connected' ? 'ghu_runas' : undefined,
      // The item records its own landing branch.
      store: { getCodebase: async () => null, getItemLanding: async () => ({ branch: 'dev' }) },
      loadConfig: async () => ({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        commands: {},
      }),
      providers: providerRegistry,
    },
  } as unknown as WorkflowHost;

  const item = { id: 'item-1', projectKey: 'project', key: 'issue-1' };

  // No configured default branch: the base is detected from the remote, a read of its own.
  const capture = (checkout: string, runAsUserId: string, onItem: typeof item | null = null) =>
    captureBindingDefinitions(
      host,
      {
        runAsUserId,
        launch: { cwd: checkout, workflowName: 'stage', isolation: { kind: 'default' } },
      } as ResourceStartBindingIntent,
      checkout,
      {
        kind: 'repo',
        name: 'project',
        default_cwd: checkout,
        default_branch: null,
        repository_url: null,
      } as Codebase,
      onItem
    );

  const scrubCaller = (): void => {
    // The node's own run is scrubbed: no token, every git credential helper reset.
    process.env.GH_TOKEN = '';
    process.env.GIT_CONFIG_PARAMETERS = "'credential.helper='";
  };

  test("reads the remote with the run-as user's token, leaving the caller scrubbed", async () => {
    for (const onItem of [null, item]) {
      const { checkout, reads } = privateProject();
      scrubCaller();

      const source = await capture(checkout, 'connected', onItem);
      await disposeWorkflowSource({ captureRoot: source.anchor.root });

      // Default-branch detection, or the item's landing check, and then the fetch.
      expect(reads()).toEqual(['token=ghu_runas', 'token=ghu_runas']);
      expect(process.env.GH_TOKEN).toBe('');
      expect(process.env.GIT_CONFIG_PARAMETERS).toBe("'credential.helper='");
    }
  }, 30_000);

  test("refuses when the run-as user has no token, reading with the scrub, not the caller's token", async () => {
    const { checkout, reads } = privateProject();
    // A caller that does hold a login, such as a host terminal.
    process.env.GH_TOKEN = 'ghu_runas';

    const error = await capture(checkout, 'unconnected').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DefinitionSourceError);
    expect(reads()).toEqual(['token=']);
  }, 30_000);
});
