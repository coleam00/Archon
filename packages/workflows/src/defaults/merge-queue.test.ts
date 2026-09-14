import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { parseWorkflow } from '../loader';
import { QUALIFICATION_METHODS } from './sdlc/qualified-evidence';
import {
  collectMergeFacts,
  createMergePlan as createPolicyPlan,
  executeMergePlan as executePolicyPlan,
  mergePlanDigest,
  mergeArguments,
  MERGE_METHODS,
  type GitHubAdapter,
  type Hold,
  GhAdapter,
  type CommandRunner,
  type MergeFacts,
  type MergeMethod,
  type MergePlan,
  type PullRequestFacts,
  type SemanticAssessment,
} from '../../../../.archon/workflows/sdlc/merge-queue/src/merge-queue';

const URL = 'https://github.com/owner/repo/pull/42';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const trackTempRoot = trackTempRoots();

const qualificationFixture = {
  references: [{ path: '/qualified.json', sha256: 'c'.repeat(64) }],
  requirements: { scope: '', context: '', scenario: '/scenario.json', holdout: '/holdout.json' },
};

function createMergePlan(facts: MergeFacts, assessment: SemanticAssessment, method: string) {
  return createPolicyPlan(facts, assessment, method, qualificationFixture);
}

// These fixtures isolate GitHub policy. qualified-evidence.test.ts exercises the
// production file verifier and the same executor without this substitution.
function executeMergePlan(
  plan: MergePlan,
  mode: string,
  approval: unknown,
  adapter: GitHubAdapter,
  digest?: string
) {
  return executePolicyPlan(plan, mode, approval, adapter, digest, async () => qualified());
}

async function runCli(env: Record<string, string>): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        '../../../../.archon/workflows/sdlc/merge-queue/scripts/merge-queue.js'
      ),
    ],
    {
      env: {
        ...process.env,
        INPUTS_EVIDENCE: '[]',
        INPUTS_QUALIFICATION_HOLDS: '[]',
        INPUTS_METHOD: '',
        INPUTS_SCOPE: qualificationFixture.requirements.scope,
        INPUTS_CONTEXT: qualificationFixture.requirements.context,
        INPUTS_RUNTIME_SCENARIO: qualificationFixture.requirements.scenario,
        INPUTS_HOLDOUT_SCENARIO: qualificationFixture.requirements.holdout,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout };
}

async function artifactsDir(): Promise<string> {
  const path = join(tmpdir(), `archon-merge-queue-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return trackTempRoot(path);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

class FakeGitHub implements GitHubAdapter {
  readonly merges: Array<{
    repository: string;
    number: number;
    method: MergeMethod;
    head: string;
  }> = [];
  policy: unknown = [];
  classicPolicy: unknown = { contexts: [], checks: [] };
  linearHistory: unknown = { enabled: false };
  checkRuns: unknown = { check_runs: [] };
  statuses: unknown = [];
  head = HEAD;
  base = BASE;
  reviewBody = 'ready';
  enabled: MergeMethod[] = ['merge', 'squash', 'rebase'];
  mergedAt = '';
  queued = false;
  failEndpoint = '';

  async api(endpoint: string): Promise<unknown> {
    if (endpoint.includes(this.failEndpoint) && this.failEndpoint !== '') {
      throw new Error(`unavailable: ${endpoint}`);
    }
    if (endpoint === 'repos/owner/repo') {
      return {
        allow_merge_commit: this.enabled.includes('merge'),
        allow_squash_merge: this.enabled.includes('squash'),
        allow_rebase_merge: this.enabled.includes('rebase'),
      };
    }
    if (endpoint === 'repos/owner/repo/pulls/42') {
      return {
        state: this.mergedAt === '' ? 'open' : 'closed',
        draft: false,
        mergeable: true,
        merged_at: this.mergedAt,
        auto_merge: this.queued ? { enabled_by: { login: 'operator' } } : null,
        review_decision: 'APPROVED',
        head: { sha: this.head, repo: { full_name: 'owner/repo' } },
        base: { ref: 'dev' },
      };
    }
    if (endpoint === 'repos/owner/repo/branches/dev') {
      return { protected: this.classicPolicy !== null, commit: { sha: this.base } };
    }
    if (endpoint.endsWith('/protection'))
      return {
        required_status_checks: this.classicPolicy,
        required_linear_history: this.linearHistory,
      };
    if (endpoint.startsWith('repos/owner/repo/rules/branches/dev')) return this.policy;
    if (endpoint.includes('/check-runs')) return this.checkRuns;
    if (endpoint.includes('/statuses')) return this.statuses;
    if (endpoint.includes('/reviews')) return [{ id: 1, body: this.reviewBody }];
    if (endpoint.includes('/issues/42/comments')) return [{ id: 2, body: this.reviewBody }];
    if (endpoint.includes('/pulls/42/comments')) return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }

  async graphql(
    _query: string,
    _variables: Readonly<Record<string, string | number>>
  ): Promise<unknown> {
    if (this.failEndpoint === 'graphql') throw new Error('graphql pagination failed');
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
  }

  async checkoutRepository(): Promise<string> {
    return 'owner/repo';
  }

  async merge(
    repository: string,
    number: number,
    method: MergeMethod,
    head: string
  ): Promise<void> {
    this.merges.push({ repository, number, method, head });
    this.mergedAt = '2026-09-13T00:00:00Z';
    this.base = 'c'.repeat(40);
  }
}

function policyResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: 'owner/repo',
        ref: { name: 'dev', target: { oid: BASE }, branchProtectionRule: null },
        rulesets: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
        ...overrides,
      },
    },
  };
}

function qualified(method: MergeMethod | '' = 'merge'): SemanticAssessment {
  return {
    ready: true,
    summary: 'qualified',
    holds: [],
    method,
    method_source: method === '' ? '' : 'caller',
    method_conflict: '',
  };
}

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    repository: 'owner/repo',
    enabledMethods: ['merge', 'squash', 'rebase'],
    pullRequests: [
      {
        url: URL,
        repository: 'owner/repo',
        number: 42,
        state: 'open',
        draft: false,
        headSha: HEAD,
        headRepository: 'owner/repo',
        base: 'dev',
        liveBaseSha: BASE,
        mergeable: true,
        reviewDecision: 'APPROVED',
        reviewFingerprint: 'review-v1',
        reviewEvidence: { reviews: [], issueComments: [], lineComments: [], threads: [] },
        requiredPolicy: 'none',
        requiredChecks: [],
        methodPolicy: {
          state: 'known',
          allowedMethods: ['merge', 'squash', 'rebase'],
          queueMethod: null,
        },
        checkState: 'passing',
        holds: [],
      },
    ],
    holds: [],
    fingerprint: 'facts-v1',
    ...overrides,
  };
}

function plan(method: MergeMethod = 'merge'): MergePlan {
  return createMergePlan(facts(), qualified(method), method).plan!;
}

describe('merge queue contract', () => {
  it('keeps every authored merge-method output schema aligned with the runtime owner', async () => {
    for (const [relativePath, nodeIds] of [
      ['../../../../.archon/workflows/sdlc/merge-queue/archon-merge-queue.yaml', ['judge', 'plan']],
      ['../../../../.archon/workflows/sdlc/lifecycle/archon-lifecycle.yaml', ['judge']],
    ] as const) {
      const path = join(import.meta.dir, relativePath);
      const parsed = parseWorkflow(await readFile(path, 'utf8'), path);
      if (parsed.workflow === null) throw new Error(parsed.error.error);
      for (const id of nodeIds) {
        const node = parsed.workflow.nodes.find(candidate => candidate.id === id);
        const format =
          node !== undefined && 'output_format' in node ? node.output_format : undefined;
        const properties = object(format?.properties);
        expect(object(properties?.method)?.enum).toEqual([...QUALIFICATION_METHODS]);
      }
    }
  });

  it('maps each method to the sole matching gh flag and pins the approved head', () => {
    for (const method of MERGE_METHODS) {
      const args = mergeArguments('owner/repo', 42, method, HEAD);
      expect(args).toEqual([
        'gh',
        'pr',
        'merge',
        '42',
        '--repo',
        'owner/repo',
        `--${method}`,
        '--match-head-commit',
        HEAD,
      ]);
      expect(args.filter(arg => ['--merge', '--squash', '--rebase'].includes(arg))).toEqual([
        `--${method}`,
      ]);
    }
  });

  it('holds missing, conflicting, unsupported, and disabled methods before a write', () => {
    expect(createMergePlan(facts(), qualified(''), '').ready).toBe(false);
    expect(createMergePlan(facts(), qualified('squash'), 'merge').ready).toBe(false);
    expect(createMergePlan(facts(), qualified(''), 'octopus').ready).toBe(false);
    expect(
      createMergePlan(facts({ enabledMethods: ['squash'] }), qualified('merge'), 'merge').ready
    ).toBe(false);
  });

  it('uses the sole repository method when the caller and project are silent', () => {
    const result = createMergePlan(facts({ enabledMethods: ['rebase'] }), qualified(''), '');
    expect(result.ready).toBe(true);
    expect(result.plan?.method).toBe('rebase');
    expect(result.plan?.methodSource).toBe('repository');
  });

  it('allows no required hosted CI only with qualified references', () => {
    expect(createMergePlan(facts(), qualified('merge'), 'merge').ready).toBe(true);
    expect(
      createPolicyPlan(facts(), qualified('merge'), 'merge', {
        ...qualificationFixture,
        references: [],
      }).ready
    ).toBe(false);
  });

  it('preserves classified semantic holds without inventing code defects', () => {
    for (const kind of ['policy', 'checks', 'evidence', 'stale', 'authorization'] as const) {
      const assessment = { ...qualified(), ready: false, holds: [{ kind, reason: 'blocked' }] };
      expect(createMergePlan(facts(), assessment, 'merge').holds).toEqual(assessment.holds);
    }
    expect(createMergePlan(facts(), { ...qualified(), ready: false }, 'merge').holds).toEqual([
      {
        kind: 'evidence',
        reason: 'semantic assessment is not ready and supplies no classified reasons',
      },
    ]);
    expect(
      createMergePlan(
        facts(),
        { ...qualified(), holds: [{ kind: 'code', reason: 'defect' }] },
        'merge'
      ).ready
    ).toBe(false);
  });

  it('classifies check runs and commit statuses against known requirements', async () => {
    const github = new FakeGitHub();
    github.policy = [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'build', integration_id: 7 }, { context: 'legacy' }],
        },
      },
    ];
    github.checkRuns = {
      check_runs: [
        { id: 10, name: 'build', status: 'completed', conclusion: 'success', app: { id: 7 } },
      ],
    };
    github.statuses = [{ id: 10, context: 'legacy', state: 'success' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('passing');

    github.statuses = [{ id: 11, context: 'legacy', state: 'pending' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('pending');
    github.statuses = [{ id: 12, context: 'legacy', state: 'failure' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('failing');
    github.statuses = [];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('missing');
  });

  it('combines classic protection and paginated ruleset requirements', async () => {
    const github = new FakeGitHub();
    github.classicPolicy = {
      contexts: ['legacy'],
      checks: [{ context: 'build', app_id: 7 }],
    };
    github.policy = [
      [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }],
      [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'security', integration_id: 9 }] },
        },
      ],
    ];
    github.checkRuns = [
      {
        total_count: 2,
        check_runs: [
          { id: 30, name: 'build', status: 'completed', conclusion: 'success', app: { id: 7 } },
        ],
      },
      {
        total_count: 2,
        check_runs: [
          { id: 31, name: 'security', status: 'completed', conclusion: 'success', app: { id: 9 } },
        ],
      },
    ];
    github.statuses = [[{ id: 20, context: 'legacy', state: 'success' }], []];
    const result = await collectMergeFacts([URL], github);
    expect(result.pullRequests[0]).toMatchObject({
      requiredPolicy: 'known',
      checkState: 'passing',
    });
    expect(result.pullRequests[0]?.requiredChecks).toHaveLength(3);
  });

  it('reduces repository, pull-request, linear-history and queue method policy', async () => {
    const github = new FakeGitHub();
    github.policy = [
      { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'rebase'] } },
      { type: 'required_linear_history' },
      { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } },
    ];
    const current = await collectMergeFacts([URL], github);
    expect(current.pullRequests[0]?.methodPolicy).toEqual({
      state: 'known',
      allowedMethods: ['squash', 'rebase'],
      queueMethod: 'squash',
    });
    expect(createMergePlan(current, qualified('squash'), 'squash').ready).toBe(true);
    expect(createMergePlan(current, qualified('rebase'), 'rebase')).toMatchObject({
      ready: false,
      holds: [{ kind: 'policy' }],
    });

    github.policy = [];
    github.linearHistory = { enabled: true };
    const classic = await collectMergeFacts([URL], github);
    expect(classic.pullRequests[0]?.methodPolicy.allowedMethods).toEqual(['squash', 'rebase']);
    expect(createMergePlan(classic, qualified('merge'), 'merge').ready).toBe(false);
  });

  it('holds malformed, conflicting, or unreadable effective method policy', async () => {
    for (const policy of [
      [{ type: 'pull_request', parameters: { allowed_merge_methods: ['octopus'] } }],
      [
        { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } },
        { type: 'merge_queue', parameters: { merge_method: 'REBASE' } },
      ],
      [{ type: 'merge_queue', parameters: {} }],
    ]) {
      const github = new FakeGitHub();
      github.policy = policy;
      const current = await collectMergeFacts([URL], github);
      expect(current.pullRequests[0]?.methodPolicy.state).toBe('unknown');
      expect(createMergePlan(current, qualified('squash'), 'squash').ready).toBe(false);
    }
  });

  it('requires distinct status and app-bound check obligations', async () => {
    const github = new FakeGitHub();
    github.classicPolicy = {
      contexts: ['build'],
      checks: [{ context: 'build', app_id: 7 }],
    };
    github.checkRuns = {
      check_runs: [
        { id: 20, name: 'build', status: 'completed', conclusion: 'success', app: { id: 8 } },
      ],
    };
    github.statuses = [{ id: 20, context: 'build', state: 'success' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('missing');

    github.checkRuns = {
      check_runs: [
        { id: 21, name: 'build', status: 'completed', conclusion: 'success', app: { id: 7 } },
      ],
    };
    github.statuses = [{ id: 21, context: 'build', state: 'failure' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('failing');
  });

  it('does not invent a status channel from overlapping classic policy fields', async () => {
    const github = new FakeGitHub();
    github.classicPolicy = { contexts: ['build'], checks: [{ context: 'build', app_id: 123 }] };
    github.checkRuns = {
      check_runs: [
        { id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: 123 } },
      ],
    };
    const facts = await collectMergeFacts([URL], github);
    expect(facts.pullRequests[0]?.requiredChecks).toHaveLength(1);
    expect(facts.pullRequests[0]?.checkState).toBe('passing');
    expect(createMergePlan(facts, qualified(), 'merge').ready).toBe(true);
  });

  it('requires both observed channels for an unbound context', async () => {
    const github = new FakeGitHub();
    github.classicPolicy = { contexts: ['build'], checks: [{ context: 'build', app_id: null }] };
    github.checkRuns = {
      check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
    };
    github.statuses = [{ id: 1, context: 'build', state: 'pending' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('pending');
    github.statuses = [{ id: 2, context: 'build', state: 'failure' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('failing');
  });

  it('accepts protected branches whose full protection explicitly requires no CI', async () => {
    const github = new FakeGitHub();
    const api = github.api.bind(github);
    github.api = async endpoint =>
      endpoint.endsWith('/protection')
        ? {
            required_status_checks: null,
            required_linear_history: { enabled: false },
            required_pull_request_reviews: { required_approving_review_count: 1 },
          }
        : api(endpoint);
    const facts = await collectMergeFacts([URL], github);
    expect(facts.pullRequests[0]?.requiredPolicy).toBe('none');
    expect(createMergePlan(facts, qualified(), 'merge').ready).toBe(true);
  });

  it('resolves unavailable REST policy with an exact-ref complete GraphQL read', async () => {
    const github = new FakeGitHub();
    github.failEndpoint = 'rules/branches';
    const graphql = github.graphql.bind(github);
    github.graphql = async (query, variables) => {
      if (!query.includes('includeParents:true')) return graphql(query, variables);
      expect(variables).toEqual({ owner: 'owner', name: 'repo', ref: 'refs/heads/dev' });
      return policyResponse();
    };
    const current = await collectMergeFacts([URL], github);
    expect(current.pullRequests[0]?.requiredPolicy).toBe('none');
    expect(createMergePlan(current, qualified(), 'merge').ready).toBe(true);
  });

  it('keeps partial, wrong-ref, and uninspected GraphQL policy unknown', async () => {
    for (const response of [
      { ...policyResponse(), errors: [{ message: 'partial data' }] },
      policyResponse({ ref: null }),
      policyResponse({ nameWithOwner: 'other/repo' }),
      policyResponse({ ref: { name: 'other', target: { oid: BASE }, branchProtectionRule: null } }),
      policyResponse({ ref: { name: 'dev', target: { oid: HEAD }, branchProtectionRule: null } }),
      policyResponse({
        rulesets: { totalCount: 1, nodes: [{ id: 'rule' }], pageInfo: { hasNextPage: false } },
      }),
      policyResponse({ rulesets: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: true } } }),
      policyResponse({ rulesets: { nodes: [], pageInfo: { hasNextPage: false } } }),
    ]) {
      const github = new FakeGitHub();
      github.failEndpoint = 'rules/branches';
      const graphql = github.graphql.bind(github);
      github.graphql = async (query, variables) =>
        query.includes('includeParents:true') ? response : graphql(query, variables);
      const facts = await collectMergeFacts([URL], github);
      expect(facts.pullRequests[0]?.requiredPolicy).toBe('unknown');
      expect(createMergePlan(facts, qualified(), 'merge').ready).toBe(false);
      expect(github.merges).toHaveLength(0);
    }
  });

  it('reads classic app requirements via GraphQL when full REST protection is unavailable', async () => {
    const github = new FakeGitHub();
    github.failEndpoint = '/protection';
    const graphql = github.graphql.bind(github);
    github.graphql = async (query, variables) =>
      query.includes('includeParents:true')
        ? policyResponse({
            ref: {
              name: 'dev',
              target: { oid: BASE },
              branchProtectionRule: {
                requiresStatusChecks: true,
                requiredStatusCheckContexts: ['build'],
                requiredStatusChecks: [{ context: 'build', app: { databaseId: 123 } }],
              },
            },
          })
        : graphql(query, variables);
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('missing');
    github.checkRuns = {
      check_runs: [
        { id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: 123 } },
      ],
    };
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('passing');
  });

  it('uses only the latest status and check-run attempt', async () => {
    const github = new FakeGitHub();
    github.classicPolicy = { contexts: ['legacy'], checks: [{ context: 'build', app_id: 7 }] };
    github.checkRuns = {
      check_runs: [
        { id: 10, name: 'build', status: 'completed', conclusion: 'success', app: { id: 7 } },
        { id: 11, name: 'build', status: 'in_progress', conclusion: null, app: { id: 7 } },
      ],
    };
    github.statuses = [
      { id: 10, context: 'legacy', state: 'success' },
      { id: 11, context: 'legacy', state: 'failure' },
    ];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('failing');
    github.statuses = [{ id: 12, context: 'legacy', state: 'success' }];
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('pending');
    github.checkRuns = {
      check_runs: [
        { id: 13, name: 'build', status: 'completed', conclusion: 'cancelled', app: { id: 7 } },
      ],
    };
    expect((await collectMergeFacts([URL], github)).pullRequests[0]?.checkState).toBe('failing');
  });

  it('treats malformed pages, classic-policy failures, and origin mismatch as unknown policy', async () => {
    const malformed = new FakeGitHub();
    malformed.policy = [[{ type: 'required_status_checks', parameters: {} }]];
    expect((await collectMergeFacts([URL], malformed)).pullRequests[0]?.requiredPolicy).toBe(
      'unknown'
    );

    const classicFailure = new FakeGitHub();
    classicFailure.classicPolicy = { contexts: ['build'], checks: [] };
    classicFailure.failEndpoint = '/protection';
    expect((await collectMergeFacts([URL], classicFailure)).pullRequests[0]?.requiredPolicy).toBe(
      'unknown'
    );

    const wrongOrigin = new FakeGitHub();
    wrongOrigin.checkoutRepository = async () => 'other/repo';
    expect(
      (await collectMergeFacts([URL], wrongOrigin)).holds.some(hold =>
        hold.reason.includes('checkout origin')
      )
    ).toBe(true);
  });

  it('holds unknown policy and incomplete or unauthorized reads as unknown', async () => {
    for (const endpoint of ['rules/branches', 'check-runs', 'statuses', 'reviews', 'graphql']) {
      const github = new FakeGitHub();
      github.policy = [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'build' }] },
        },
      ];
      github.failEndpoint = endpoint;
      const result = await collectMergeFacts([URL], github);
      expect(result.holds.length).toBeGreaterThan(0);
      expect(
        result.pullRequests[0]?.requiredPolicy === 'unknown' ||
          result.pullRequests[0]?.checkState === 'unknown' ||
          result.pullRequests[0]?.holds.some(hold => hold.reason.includes('review'))
      ).toBe(true);
    }
  });

  it('executes the approved method and reports a confirmed merge', async () => {
    const github = new FakeGitHub();
    const current = await collectMergeFacts([URL], github);
    const approved = createMergePlan(current, qualified('squash'), 'squash').plan!;
    const result = await executeMergePlan(approved, 'auto', null, github);
    expect(result.merged).toBe(true);
    expect(result.urls).toEqual([URL]);
    expect(github.merges).toEqual([
      { repository: 'owner/repo', number: 42, method: 'squash', head: HEAD },
    ]);
  });

  it('makes no write when authorization, head, base, review, checks, or method changes', async () => {
    const cases: Array<(github: FakeGitHub) => void> = [
      github => {
        github.head = 'd'.repeat(40);
      },
      github => {
        github.base = 'd'.repeat(40);
      },
      github => {
        github.reviewBody = 'changed';
      },
      github => {
        github.policy = [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'build' }] },
          },
        ];
      },
      github => {
        github.enabled = ['squash'];
      },
      github => {
        github.policy = [{ type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }];
      },
    ];
    for (const mutate of cases) {
      const github = new FakeGitHub();
      const current = await collectMergeFacts([URL], github);
      const approved = createMergePlan(current, qualified('merge'), 'merge').plan!;
      mutate(github);
      expect((await executeMergePlan(approved, 'auto', null, github)).merged).toBe(false);
      expect(github.merges).toHaveLength(0);
    }
    const github = new FakeGitHub();
    expect((await executeMergePlan(plan(), 'approve', { decision: 'hold' }, github)).merged).toBe(
      false
    );
    expect(github.merges).toHaveLength(0);
  });

  it('rechecks review content in the final facts read before the write', async () => {
    const github = new FakeGitHub();
    const current = await collectMergeFacts([URL], github);
    const approved = createMergePlan(current, qualified('merge'), 'merge').plan!;
    let reviewReads = 0;
    const originalApi = github.api.bind(github);
    github.api = async endpoint => {
      if (endpoint.includes('/reviews')) {
        reviewReads += 1;
        if (reviewReads === 2) github.reviewBody = 'changed immediately before write';
      }
      return originalApi(endpoint);
    };
    expect((await executeMergePlan(approved, 'auto', null, github)).merged).toBe(false);
    expect(github.merges).toHaveLength(0);
  });

  it('rechecks required checks in the final facts read before the write', async () => {
    const github = new FakeGitHub();
    const current = await collectMergeFacts([URL], github);
    const approved = createMergePlan(current, qualified('merge'), 'merge').plan!;
    let policyReads = 0;
    const originalApi = github.api.bind(github);
    github.api = async endpoint => {
      if (endpoint.includes('/rules/branches/')) {
        policyReads += 1;
        if (policyReads === 2) {
          github.policy = [
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'new-check' }] },
            },
          ];
        }
      }
      return originalApi(endpoint);
    };
    const result = await executeMergePlan(approved, 'auto', null, github);
    expect(result.merged).toBe(false);
    expect(result.holds.some(hold => hold.reason.includes('required checks'))).toBe(true);
    expect(github.merges).toHaveLength(0);
  });

  it('binds execution to the approved plan digest', async () => {
    const github = new FakeGitHub();
    const approved = plan();
    expect((await executeMergePlan(approved, 'auto', null, github, 'wrong')).holds[0]?.kind).toBe(
      'authorization'
    );
    expect(mergePlanDigest(approved)).toHaveLength(64);
    expect(github.merges).toHaveLength(0);
  });

  it('reports a successful queue request as queued, not merged', async () => {
    const github = new FakeGitHub();
    github.merge = async (repository, number, method, head): Promise<void> => {
      github.merges.push({ repository, number, method, head });
      github.queued = true;
    };
    const current = await collectMergeFacts([URL], github);
    const approved = createMergePlan(current, qualified('merge'), 'merge').plan!;
    const result = await executeMergePlan(approved, 'auto', null, github);
    expect(result).toMatchObject({ merged: false, urls: [], queued: [URL] });
  });

  it('uses the production command adapter with exact merge argv', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run(argv) {
        calls.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    await new GhAdapter(runner).merge('owner/repo', 42, 'rebase', HEAD);
    expect(calls).toEqual([mergeArguments('owner/repo', 42, 'rebase', HEAD)]);
  });

  it('returns typed holds from production CLI held and preview paths without GitHub access', async () => {
    const heldArtifacts = await artifactsDir();
    const heldPlan = await runCli({
      INPUTS_ACTION: 'plan',
      INPUTS_FACTS: JSON.stringify(
        facts({ holds: [{ kind: 'checks', reason: 'required checks are pending' }] })
      ),
      INPUTS_ASSESSMENT: JSON.stringify(qualified('merge')),
      INPUTS_METHOD: 'merge',
      ARTIFACTS_DIR: heldArtifacts,
    });
    expect(heldPlan.exitCode).toBe(0);
    const heldPlanOutput = JSON.parse(heldPlan.stdout) as {
      ready: boolean;
      summary: string;
      holds: Hold[];
    };
    expect(heldPlanOutput.ready).toBe(false);
    expect(heldPlanOutput.holds).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'checks' })])
    );
    const held = await runCli({
      INPUTS_ACTION: 'execute',
      INPUTS_READY: String(heldPlanOutput.ready),
      INPUTS_PLAN_SUMMARY: heldPlanOutput.summary,
      INPUTS_PLAN_HOLDS: JSON.stringify(heldPlanOutput.holds),
      ARTIFACTS_DIR: heldArtifacts,
    });
    expect(held.exitCode).toBe(0);
    expect(JSON.parse(held.stdout)).toMatchObject({ merged: false });
    expect(await readFile(join(heldArtifacts, 'merge-result.md'), 'utf8')).toContain(
      'required checks are pending'
    );
    expect(await readFile(join(heldArtifacts, 'merge-hold.md'), 'utf8')).toContain(HEAD);
    const reassessed = await runCli({
      INPUTS_ACTION: 'plan',
      INPUTS_FACTS: JSON.stringify(facts()),
      INPUTS_ASSESSMENT: JSON.stringify(qualified()),
      INPUTS_METHOD: 'merge',
      ARTIFACTS_DIR: heldArtifacts,
    });
    expect(reassessed.exitCode).toBe(0);
    const feedback = await readFile(join(heldArtifacts, 'merge-hold.md'), 'utf8');
    expect(feedback).toContain('qualified');
    expect(feedback).not.toContain('required checks are pending');

    const previewArtifacts = await artifactsDir();
    const readyPlan = await runCli({
      INPUTS_ACTION: 'plan',
      INPUTS_FACTS: JSON.stringify(facts()),
      INPUTS_ASSESSMENT: JSON.stringify(qualified('merge')),
      INPUTS_METHOD: 'merge',
      ARTIFACTS_DIR: previewArtifacts,
    });
    expect(readyPlan.exitCode).toBe(0);
    const readyPlanOutput = JSON.parse(readyPlan.stdout) as {
      ready: boolean;
      plan_reference: string;
      plan_digest: string;
      summary: string;
      holds: Hold[];
    };
    expect(readyPlanOutput.ready).toBe(false);
    const preview = await runCli({
      INPUTS_ACTION: 'execute',
      INPUTS_READY: String(readyPlanOutput.ready),
      INPUTS_PLAN_REFERENCE: readyPlanOutput.plan_reference,
      INPUTS_PLAN_DIGEST: readyPlanOutput.plan_digest,
      INPUTS_PLAN_SUMMARY: readyPlanOutput.summary,
      INPUTS_PLAN_HOLDS: JSON.stringify(readyPlanOutput.holds),
      INPUTS_MODE: 'preview',
      INPUTS_APPROVAL: 'null',
      ARTIFACTS_DIR: previewArtifacts,
    });
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      merged: false,
    });
  });

  it('rejects malformed facts and raw ready claims at the production action boundary', async () => {
    const artifacts = await artifactsDir();
    const malformedFacts = facts();
    delete (malformedFacts.pullRequests[0] as Partial<PullRequestFacts>).reviewEvidence;
    expect(
      (
        await runCli({
          INPUTS_ACTION: 'plan',
          INPUTS_FACTS: JSON.stringify(malformedFacts),
          INPUTS_ASSESSMENT: JSON.stringify(qualified('merge')),
          INPUTS_METHOD: 'merge',
          ARTIFACTS_DIR: artifacts,
        })
      ).exitCode
    ).not.toBe(0);

    const malformedAssessment = { ...qualified('merge'), evidence: { state: 'qualified' } };
    expect(
      (
        await runCli({
          INPUTS_ACTION: 'plan',
          INPUTS_FACTS: JSON.stringify(facts()),
          INPUTS_EVIDENCE: JSON.stringify(malformedAssessment),
          INPUTS_METHOD: 'merge',
          ARTIFACTS_DIR: artifacts,
        })
      ).exitCode
    ).not.toBe(0);
  });
});
