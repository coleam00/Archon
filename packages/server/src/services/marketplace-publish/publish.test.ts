import { describe, test, expect } from 'bun:test';
import {
  submitToMarketplace,
  SubmitBlockedError,
  PostCommitFailureError,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
  UPSTREAM_BASE_BRANCH,
  MARKETPLACE_PATH,
  type PublishDeps,
  type SubmitParams,
} from './publish';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { DagNode } from '@archon/workflows/schemas/dag-node';
import type { BundleFile } from './bundle';
import type { Octokit } from '@octokit/rest';

const SECRET_TOKEN = 'ghp_super-secret-token-value';

const WORKFLOW: WorkflowDefinition = {
  name: 'My Flow',
  description: 'Does the thing.',
  tags: ['development'],
  nodes: [{ id: 'n1', prompt: 'go' } as DagNode],
};

const YAML_CONTENT =
  'name: My Flow\ndescription: Does the thing.\nnodes:\n  - id: n1\n    prompt: go\n';

const BUNDLE: BundleFile[] = [
  { repoPath: '.archon/marketplace/my-flow/my-flow.yaml', content: YAML_CONTENT },
];

const UPSTREAM_MARKETPLACE_SOURCE = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'other-flow',
    name: 'Other Flow',
    author: 'someone-else',
    description: 'Not related.',
    sourceUrl: 'https://github.com/someone-else/proj/tree/1111111111111111111111111111111111111111/.archon/marketplace/other-flow',
    sha: '1111111111111111111111111111111111111111',
    tags: ['development'],
    archonVersionCompat: '>=0.3.0',
  },
];
`;

interface CallLog {
  calls: string[];
}

function base64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

/** Builds a fully-mocked Octokit that logs every REST call it receives. */
function makeOctokit(
  log: CallLog,
  overrides: Record<string, (...args: unknown[]) => unknown> = {}
): Octokit {
  function call<T>(name: string, impl: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]) => {
      log.calls.push(name);
      const override = overrides[name];
      if (override) return override(...args) as T;
      return impl(...args);
    };
  }

  return {
    rest: {
      repos: {
        get: call('repos.get', () => ({
          data: {
            private: false,
            archived: false,
            default_branch: 'main',
            permissions: { push: true },
          },
        })),
        getContent: call('repos.getContent', (params: unknown) => {
          const p = params as { owner: string; repo: string; path: string };
          if (p.owner === UPSTREAM_OWNER && p.path === MARKETPLACE_PATH) {
            return {
              data: {
                type: 'file',
                content: base64(UPSTREAM_MARKETPLACE_SOURCE),
                sha: 'upstream-file-sha',
              },
            };
          }
          return { data: { type: 'file', content: base64('bundled'), sha: 'bundle-file-sha' } };
        }),
        createFork: call('repos.createFork', () => ({ data: {} })),
        mergeUpstream: call('repos.mergeUpstream', () => ({ data: {} })),
        createOrUpdateFileContents: call('repos.createOrUpdateFileContents', () => ({ data: {} })),
      },
      git: {
        getRef: call('git.getRef', (params: unknown) => {
          const p = params as { ref: string };
          return {
            data: {
              object: { sha: p.ref.includes('dev') ? 'upstream-dev-sha' : 'base-commit-sha' },
            },
          };
        }),
        getCommit: call('git.getCommit', () => ({ data: { tree: { sha: 'base-tree-sha' } } })),
        createBlob: call('git.createBlob', () => ({ data: { sha: 'blob-sha-1' } })),
        createTree: call('git.createTree', () => ({ data: { sha: 'new-tree-sha' } })),
        createCommit: call('git.createCommit', () => ({
          data: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        })),
        updateRef: call('git.updateRef', () => ({ data: {} })),
        createRef: call('git.createRef', () => ({ data: {} })),
      },
      users: {
        getAuthenticated: call('users.getAuthenticated', () => ({
          data: { login: 'seanrobertwright' },
        })),
      },
      pulls: {
        create: call('pulls.create', () => ({
          data: { html_url: 'https://github.com/coleam00/Archon/pull/9999' },
        })),
      },
    },
  } as unknown as Octokit;
}

function makeDeps(overrides: Partial<PublishDeps> = {}): PublishDeps {
  return {
    octokitFactory: () => makeOctokit({ calls: [] }),
    isPerUserGitHubEnabled: () => false,
    getDecryptedAccessToken: async () => null,
    getUserGithubTokenRecord: async () => null,
    getUserGithubNoreplyEmail: async () => null,
    findRepoRoot: async () => '/fake/project/root' as never,
    getRemoteUrl: async () => 'https://github.com/seanrobertwright/proj.git' as never,
    readFile: async () => YAML_CONTENT,
    parseWorkflow: () => ({ workflow: WORKFLOW, error: null }) as never,
    buildMarketplaceBundle: async () => BUNDLE,
    runPreflightGates: async () => ({
      passed: true,
      gates: [
        { name: 'schema-validate', passed: true, detail: { valid: true, files: [] } },
        {
          name: 'security-scan',
          passed: true,
          detail: { severity: 'none', finding_count: 0, findings: [] },
        },
      ],
    }),
    sleep: async () => undefined,
    serverCwd: '/fake/archon',
    env: { GITHUB_TOKEN: SECRET_TOKEN },
    appVersion: '0.5.0',
    ...overrides,
  };
}

const PARAMS: SubmitParams = {
  userId: undefined,
  cwd: '/fake/project',
  workflowName: 'My Flow',
  attestation: {
    noExfiltration: true,
    noDestructiveOps: true,
    rightToShare: true,
    shaReviewed: true,
  },
};

describe('submitToMarketplace — happy path', () => {
  test('appends a new entry and opens a non-draft PR against dev', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({ octokitFactory: () => makeOctokit(log) });
    const result = await submitToMarketplace(deps, PARAMS);

    expect(result.action).toBe('append');
    expect(result.slug).toBe('my-flow');
    expect(result.bundleCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.prUrl).toBe('https://github.com/coleam00/Archon/pull/9999');
  });

  test('call order: collision-check fetch happens before the bundle commit write', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({ octokitFactory: () => makeOctokit(log) });
    await submitToMarketplace(deps, PARAMS);

    const collisionFetchIndex = log.calls.indexOf('repos.getContent'); // first getContent call = upstream registry fetch
    const firstWriteIndex = log.calls.findIndex(c =>
      ['git.createBlob', 'git.createTree', 'git.createCommit', 'git.updateRef'].includes(c)
    );
    expect(collisionFetchIndex).toBeGreaterThanOrEqual(0);
    expect(firstWriteIndex).toBeGreaterThan(collisionFetchIndex);
  });

  test('call order: preflight gates run before the bundle commit', async () => {
    const log: CallLog = { calls: [] };
    let preflightCalledAt = -1;
    const deps = makeDeps({
      octokitFactory: () => makeOctokit(log),
      runPreflightGates: async () => {
        preflightCalledAt = log.calls.length;
        return {
          passed: true,
          gates: [
            { name: 'schema-validate', passed: true, detail: { valid: true, files: [] } },
            {
              name: 'security-scan',
              passed: true,
              detail: { severity: 'none', finding_count: 0, findings: [] },
            },
          ],
        };
      },
    });
    await submitToMarketplace(deps, PARAMS);
    const firstWriteIndex = log.calls.findIndex(c => c === 'git.createBlob');
    expect(preflightCalledAt).toBeLessThan(firstWriteIndex);
  });

  test('resolves the PAT identity via users.getAuthenticated when no per-user token is used', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({ octokitFactory: () => makeOctokit(log) });
    await submitToMarketplace(deps, PARAMS);
    expect(log.calls).toContain('users.getAuthenticated');
  });

  test('never logs or returns the resolved token anywhere in the result', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({ octokitFactory: () => makeOctokit(log) });
    const result = await submitToMarketplace(deps, PARAMS);
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });
});

describe('submitToMarketplace — update path', () => {
  test('updates in place when the slug is owned by the same (case-insensitive) author', async () => {
    const ownSlugSource = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'my-flow',
    name: 'My Flow',
    author: 'SeanRobertWright',
    description: 'Does the thing.',
    sourceUrl: 'https://github.com/seanrobertwright/proj/tree/1111111111111111111111111111111111111111/.archon/marketplace/my-flow',
    sha: '1111111111111111111111111111111111111111',
    tags: ['development'],
    archonVersionCompat: '>=0.3.0',
  },
];
`;
    const log: CallLog = { calls: [] };
    const octokit = makeOctokit(log, {
      'repos.getContent': (params: unknown) => {
        const p = params as { owner: string; path: string };
        if (p.owner === UPSTREAM_OWNER && p.path === MARKETPLACE_PATH) {
          return {
            data: { type: 'file', content: base64(ownSlugSource), sha: 'upstream-file-sha' },
          };
        }
        return { data: { type: 'file', content: base64('bundled'), sha: 'bundle-file-sha' } };
      },
    });
    const deps = makeDeps({ octokitFactory: () => octokit });
    const result = await submitToMarketplace(deps, PARAMS);
    expect(result.action).toBe('update');
  });
});

describe('submitToMarketplace — block-before-write cases', () => {
  test('no credential -> SubmitBlockedError, zero Octokit calls', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({
      octokitFactory: () => makeOctokit(log),
      env: {},
    });
    await expect(submitToMarketplace(deps, PARAMS)).rejects.toThrow(SubmitBlockedError);
    expect(log.calls).toHaveLength(0);
  });

  test('no GitHub origin -> SubmitBlockedError before any Octokit call', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({
      octokitFactory: () => makeOctokit(log),
      getRemoteUrl: async () => null,
    });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubmitBlockedError);
    expect((caught as SubmitBlockedError).block).toEqual({ kind: 'origin', reason: 'no-origin' });
    expect(log.calls).toHaveLength(0);
  });

  test('private repo -> SubmitBlockedError, no writes', async () => {
    const log: CallLog = { calls: [] };
    const octokit = makeOctokit(log, {
      'repos.get': () => ({
        data: {
          private: true,
          archived: false,
          default_branch: 'main',
          permissions: { push: true },
        },
      }),
    });
    const deps = makeDeps({ octokitFactory: () => octokit });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubmitBlockedError);
    expect((caught as SubmitBlockedError).block).toEqual({ kind: 'origin', reason: 'private' });
    expect(log.calls.some(c => c.startsWith('git.'))).toBe(false);
  });

  test('collision (different author) -> 409-shaped block, nothing written', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({ octokitFactory: () => makeOctokit(log) }); // fixture registers 'other-flow' under 'someone-else'
    const collidingParams: SubmitParams = { ...PARAMS, workflowName: 'Other Flow' };
    let caught: unknown;
    try {
      await submitToMarketplace(deps, collidingParams);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubmitBlockedError);
    expect((caught as SubmitBlockedError).block).toEqual({
      kind: 'collision',
      owner: 'someone-else',
    });
    expect(log.calls.some(c => c.startsWith('git.'))).toBe(false);
    expect(log.calls).not.toContain('repos.createFork');
  });

  test('preflight failure -> SubmitBlockedError, no commit', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({
      octokitFactory: () => makeOctokit(log),
      runPreflightGates: async () => ({
        passed: false,
        gates: [
          { name: 'schema-validate', passed: false, detail: { valid: false, files: [] } },
          {
            name: 'security-scan',
            passed: true,
            detail: { severity: 'none', finding_count: 0, findings: [] },
          },
        ],
      }),
    });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubmitBlockedError);
    expect((caught as SubmitBlockedError).block).toMatchObject({ kind: 'preflight' });
    expect(log.calls.some(c => c.startsWith('git.'))).toBe(false);
  });

  test('missing workflow file on disk -> SubmitBlockedError before any Octokit call', async () => {
    const log: CallLog = { calls: [] };
    const deps = makeDeps({
      octokitFactory: () => makeOctokit(log),
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubmitBlockedError);
    expect((caught as SubmitBlockedError).block).toMatchObject({ kind: 'workflow-not-found' });
  });
});

describe('submitToMarketplace — post-commit failure contract', () => {
  test('reports the landed bundle repo + sha when the fork/PR leg fails after the commit', async () => {
    const log: CallLog = { calls: [] };
    const octokit = makeOctokit(log, {
      'repos.createFork': () => {
        throw new Error('simulated fork failure');
      },
    });
    const deps = makeDeps({ octokitFactory: () => octokit });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PostCommitFailureError);
    const failure = caught as PostCommitFailureError;
    expect(failure.bundleRepo).toBe('seanrobertwright/proj');
    expect(failure.bundleCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    // The commit itself DID happen before this failure.
    expect(log.calls).toContain('git.updateRef');
  });

  test('never leaks the token in a post-commit failure message', async () => {
    const log: CallLog = { calls: [] };
    const octokit = makeOctokit(log, {
      'repos.createFork': () => {
        throw new Error(`failed while using token ${SECRET_TOKEN}`);
      },
    });
    const deps = makeDeps({ octokitFactory: () => octokit });
    let caught: unknown;
    try {
      await submitToMarketplace(deps, PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PostCommitFailureError);
    expect((caught as PostCommitFailureError).message).not.toContain(SECRET_TOKEN);
  });
});

describe('submitToMarketplace — fork branch creation fallback', () => {
  test('retries createRef via mergeUpstream on a divergent-fork rejection', async () => {
    const log: CallLog = { calls: [] };
    let createRefAttempts = 0;
    const octokit = makeOctokit(log, {
      'git.createRef': () => {
        createRefAttempts++;
        if (createRefAttempts === 1) throw new Error('reference already exists / divergent');
        return { data: {} };
      },
    });
    const deps = makeDeps({ octokitFactory: () => octokit });
    const result = await submitToMarketplace(deps, PARAMS);
    expect(result.prUrl).toBeDefined();
    expect(log.calls.filter(c => c === 'git.createRef')).toHaveLength(2);
    expect(log.calls).toContain('repos.mergeUpstream');
  });
});
