/**
 * The forge source, end to end: the pack's publishing scripts drive the real
 * `archon forge` command, its dispatch, and the real GitHub plugin
 * process, which talks to a fake GitHub (./fixtures/sdlc-fake-github.ts).
 *
 * The other pack tests fake the CLI's answers. This one proves the pieces agree:
 * a delivery creates a draft pull request and upserts the same review comment
 * across rounds, and none of
 * those steps calls `gh`; intake's close links a resolved issue both ways.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  PR,
  gitCheckout,
  packScriptRunner,
  type ScriptOptions,
  type ScriptRun,
} from '../.archon/scripts/__tests__/deliver-checks-harness';
import { FAKE_HOST, initialState, type FakeGitHubState } from './fixtures/sdlc-fake-github';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflows } from '../packages/workflows/src/workflow-discovery';
import { dryRunWorkflow } from '../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';
import { resolveWorkflow, resolvedBodyNodes } from '../packages/workflows/src/graph-plan';
import { DESCRIPTION_SECTION } from '../.archon/workflows/sdlc/.shared/pr';
import { closeComments, type Closure, planClose } from '../.archon/workflows/sdlc/.shared/close';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();
const REPO_ROOT = resolve(import.meta.dir, '..');
const FORGE_COMMAND = join(REPO_ROOT, 'packages/cli/src/commands/forge.ts');
const GITHUB_PLUGIN = join(REPO_ROOT, 'packages/adapters/src/forge/github/plugin.ts');
const FAKE_GITHUB = join(import.meta.dir, 'fixtures/sdlc-fake-github.ts');

const MARKER = '<!-- archon-review-report -->';
const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });
const OPENING_BODY = 'Opening body: the change adds a guard.';

/** A host with the GitHub plugin configured for the fake host and a host command. */
function forgeHost(other = false, headSha = 'deadbeef'): { argv: string[]; statePath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-delivery-')));
  const home = join(root, 'home');
  mkdirSync(home);
  const statePath = join(root, 'github.json');
  writeFileSync(
    statePath,
    JSON.stringify(
      other
        ? {
            issues: [
              { number: 7, title: 'Triage', body: '', labels: ['operator', 'archon-blocked'] },
            ],
            labels: [
              { name: 'operator', color: 'abcdef', description: '' },
              { name: 'area', color: 'abcdef', description: '' },
              { name: 'archon-blocked', color: 'abcdef', description: '' },
            ],
            operations: [],
            writes: [],
          }
        : initialState(headSha)
    )
  );

  const preload = join(root, 'fake-github.ts');
  writeFileSync(
    preload,
    `import { install } from ${JSON.stringify(FAKE_GITHUB)};\ninstall(${JSON.stringify(statePath)});\n`
  );
  const config = join(home, 'config.yaml');
  writeFileSync(
    config,
    JSON.stringify({
      forge: {
        scanPath: false,
        hosts: {
          [other ? 'tracker.example' : FAKE_HOST]: {
            plugin: other ? 'tracker' : 'github',
            command: process.execPath,
            args: other
              ? [
                  '--no-env-file',
                  join(import.meta.dir, 'fixtures/sdlc-workitem-plugin.ts'),
                  '--state',
                  statePath,
                ]
              : ['--no-env-file', '--preload', preload, GITHUB_PLUGIN],
          },
        },
      },
    })
  );

  // The host command: the real `archon forge` command function with a trusted
  // Archon home and a run id. The host audit is covered by the CLI tests.
  const cli = join(root, 'archon.ts');
  writeFileSync(
    cli,
    `import { forgeCommand } from ${JSON.stringify(FORGE_COMMAND)};
const [command, op, ...rest] = process.argv.slice(2);
if (command !== 'forge') throw new Error('unexpected host command: ' + String(command));
const flag = (name: string): string | undefined => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const env = {
  ...process.env,
  HOME: ${JSON.stringify(home)},
  ARCHON_HOME: ${JSON.stringify(home)},
  GH_TOKEN: 'fake-token',
  WORKFLOW_ID: 'run-forge-delivery',
};
process.exitCode = await forgeCommand(
  op,
  { data: flag('--data'), dataFile: flag('--data-file'), configPath: ${JSON.stringify(config)}, trustedEnv: env },
  {
    env,
    audit: async () => {},
  }
);
`
  );
  return { argv: [process.execPath, '--no-env-file', cli], statePath };
}

describe('the forge source delivers through plugin operations', () => {
  it('creates a draft and upserts one review comment', () => {
    // A real checkout whose recorded remote is a local bare repository: publish-pr pushes
    // it before it creates.
    const CHECKOUT = gitCheckout({}, trackTempRoot);
    const HEAD_SHA = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: CHECKOUT,
      encoding: 'utf8',
    }).stdout.trim();
    const ROUND_ONE = `Round one at ${HEAD_SHA}: one finding still open.`;
    const ROUND_TWO = `Round two at ${HEAD_SHA}: every finding resolved.`;
    const host = forgeHost(false, HEAD_SHA);
    const through = (relative: string, options: ScriptOptions = {}): ScriptRun => {
      const run = runPackScript(relative, {
        cwd: CHECKOUT,
        ...options,
        source: 'forge',
        forge: { kind: 'command', argv: host.argv },
      });
      expect({ script: relative, code: run.code, stderr: run.stderr }).toMatchObject({
        code: 0,
      });
      // The forge path never reaches for gh, not even to read.
      expect(run.gh).toEqual([]);
      return run;
    };
    const github = (): FakeGitHubState =>
      JSON.parse(readFileSync(host.statePath, 'utf8')) as FakeGitHubState;
    const review = (report: string, ready: boolean): void => {
      through('review/scripts/publish-review', {
        inputs: {
          INPUTS_PR: JSON.stringify(PR),
          INPUTS_REPORT: '{ARTIFACTS}/report.md',
          INPUTS_HEAD: HEAD_SHA,
          ARCHON_NODE_EXECUTION: JSON.stringify({
            attempt: { checkoutStart: { kind: 'git', commit: HEAD_SHA } },
          }),
          INPUTS_READY: String(ready),
          INPUTS_ACTION: ready ? 'none' : 'correct',
          INPUTS_SUMMARY: 'summary',
          INPUTS_REPORT_POINTER: JSON.stringify({ path: 'review/report.md' }),
          INPUTS_DISCOVERIES: '[]',
          INPUTS_CONTRACT_LEFT: '[]',
        },
        artifacts: { 'report.md': report },
      });
    };

    // 1. The draft pull request.
    const created = through('pr/scripts/publish-pr', {
      inputs: {
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_HEAD_REPO: JSON.stringify(PR.repo),
        INPUTS_HEAD: 'feature',
        INPUTS_BASE: 'dev',
        INPUTS_EXISTING: 'null',
        INPUTS_TITLE: 'Add a guard',
        WORKFLOW_ID: 'run-forge-delivery',
        INPUTS_BODY: JSON.stringify({
          type: 'archon_artifact',
          run_id: 'run-forge-delivery',
          path: 'pr-body.md',
        }),
        INPUTS_DRAFT: 'true',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      },
      artifacts: { 'pr-body.md': OPENING_BODY, 'listing.json': EMPTY_LISTING },
    });
    const record = JSON.parse(created.stdout) as Record<string, unknown>;
    expect(record).toMatchObject({ number: 42, is_draft: true, head_revision: HEAD_SHA });

    // 2. The first review round's canonical comment.
    review(ROUND_ONE, false);

    // 3. The second round edits the same comment rather than adding one.
    review(ROUND_TWO, true);

    const state = github();
    expect(state.pulls).toHaveLength(1);
    expect(state.pulls[0]).toMatchObject({ draft: true });
    expect(state.comments).toEqual([
      {
        id: 900,
        body: `${MARKER}\nReviewed commit: \`${HEAD_SHA}\`\nVerdict: ready\nContract: complete\n\n${ROUND_TWO}`,
      },
    ]);
    const writes = state.calls.filter(call => !call.startsWith('GET '));
    expect(writes.map(call => call.replace(/\?.*$/, ''))).toEqual([
      `POST https://${FAKE_HOST}/api/v3/repos/example/repo/pulls`,
      `POST https://${FAKE_HOST}/api/v3/repos/example/repo/issues/42/comments`,
      `PATCH https://${FAKE_HOST}/api/v3/repos/example/repo/issues/comments/900`,
    ]);
  }, 120_000);
});

// Agent outputs are fixture data; publication and the review read use the real
// composed bindings and publisher, CLI, and GitHub adapter against the fake API.
it('a description-only round publishes prepared content before review and finishes in one round', async () => {
  // A real checkout whose recorded remote is a local bare repository: publish-pr pushes
  // it before it creates.
  const CHECKOUT = gitCheckout({}, trackTempRoot);
  const HEAD_SHA = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: CHECKOUT,
    encoding: 'utf8',
  }).stdout.trim();
  const catalog = await discoverWorkflows(REPO_ROOT, {
    providers: providerRegistry,
    loadDefaults: false,
  });
  const entry = catalog.workflows.find(row => row.workflow.name === 'archon-deliver-block');
  if (!entry) throw new Error(JSON.stringify(catalog.errors));
  const fixturePath = join(
    REPO_ROOT,
    '.archon/workflows/sdlc/deliver/fixtures/description-only.stubs.yaml'
  );
  const fixture = parseFixtureFile(readFileSync(fixturePath, 'utf8'), fixturePath);
  const evidence = '| case | ms |\n| --- | --- |\n| real publisher | 12 |';
  const authored = 'Written by the author.  \n\n';

  for (const loseBinding of [false, true]) {
    const host = forgeHost(false, HEAD_SHA);
    const initial = runPackScript('pr/scripts/publish-pr', {
      cwd: CHECKOUT,
      source: 'forge',
      forge: { kind: 'command', argv: host.argv },
      inputs: {
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_HEAD_REPO: JSON.stringify(PR.repo),
        INPUTS_HEAD: 'feature',
        INPUTS_BASE: 'dev',
        INPUTS_EXISTING: '',
        INPUTS_PULL_REQUEST: '',
        INPUTS_TITLE: 'Description-only fixture',
        INPUTS_DRAFT: 'true',
        INPUTS_DESCRIPTION: '',
        INPUTS_PUBLISH_DESCRIPTION: 'false',
        WORKFLOW_ID: 'run',
        INPUTS_BODY: JSON.stringify({ type: 'archon_artifact', run_id: 'run', path: 'pr-body.md' }),
      },
      artifacts: { 'pr-body.md': authored },
    });
    expect({ code: initial.code, stderr: initial.stderr }).toMatchObject({ code: 0 });
    const preparedStub = fixture.stubs.pr__prepare;
    if (typeof preparedStub !== 'object' || preparedStub === null || Array.isArray(preparedStub))
      throw new Error('description-only fixture has no prepared PR intent');
    const prepared = {
      ...preparedStub,
      repo: PR.repo,
      head_repo: PR.repo,
      head: 'feature',
      description: { type: 'archon_artifact', run_id: 'dry-run', path: 'pr-description.md' },
    };
    const stubs = { ...fixture.stubs };
    for (const id of ['pr__prepare', 'pr__publish', 'review__scope']) delete stubs[id];
    const workflow = resolveWorkflow({
      ...entry.workflow,
      nodes: entry.workflow.nodes.map(node =>
        node.kind !== 'loop_group'
          ? node
          : {
              ...node,
              loop_group: {
                ...node.loop_group,
                nodes: resolvedBodyNodes(node.loop_group).map(body => {
                  if (body.id === 'pr__prepare')
                    return {
                      ...body,
                      kind: 'exec' as const,
                      runtime: 'bun' as const,
                      script: `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.ARTIFACTS_DIR + '/pr-description.md', ${JSON.stringify(evidence)});
console.log(${JSON.stringify(JSON.stringify(prepared))});`,
                    };
                  if (body.id === 'pr__publish' && body.kind === 'exec')
                    return {
                      ...body,
                      with: loseBinding ? { ...body.with, description: null } : body.with,
                      script: `process.env.ARCHON_SDLC_FORGE = 'forge';
process.env.ARCHON_CLI_COMMAND = ${JSON.stringify(JSON.stringify(host.argv))};
await import(${JSON.stringify(join(REPO_ROOT, '.archon/workflows/sdlc/pr/scripts/publish-pr.ts'))});`,
                    };
                  if (body.id === 'review__scope')
                    return {
                      ...body,
                      kind: 'exec' as const,
                      runtime: 'bun' as const,
                      script: `import {readFileSync} from 'node:fs';
const state = JSON.parse(readFileSync(${JSON.stringify(host.statePath)}, 'utf8'));
const pr = state.pulls[0];
if (pr.head.sha !== ${JSON.stringify(HEAD_SHA)} || pr.body !== ${JSON.stringify(`${authored}${DESCRIPTION_SECTION.start}
${evidence}

${DESCRIPTION_SECTION.end}
`)}) throw new Error('review did not see prepared description at the published head');
console.log(${JSON.stringify(JSON.stringify(fixture.stubs.review__scope))});`,
                    };
                  return body;
                }),
              },
            }
      ),
    });
    const result = await dryRunWorkflow({
      workflow,
      cwd: REPO_ROOT,
      execWorkspace: CHECKOUT,
      userMessage: '',
      stubs,
      execCode: true,
      inputs: fixture.declaration.inputs,
    });
    if (loseBinding) {
      expect(
        result.trace.find(row => row.nodeId === 'review__scope' && row.state === 'failed')?.reason
      ).toContain('review did not see prepared description');
    } else {
      expect({
        outcome: result.outcome,
        failures: result.trace.filter(row => row.state === 'failed'),
      }).toEqual({ outcome: 'completed', failures: [] });
      const rounds = result.trace.filter(
        row => row.nodeId === 'round' && row.state === 'completed'
      );
      expect(rounds).toHaveLength(1);
      expect(JSON.parse(rounds[0].output ?? '{}')).toMatchObject({
        done: true,
        ready: true,
        reason: 'delivered',
      });
      const state = JSON.parse(readFileSync(host.statePath, 'utf8')) as FakeGitHubState;
      expect(
        state.calls.filter(call => call.startsWith('PATCH ') && call.endsWith('/pulls/42'))
      ).toHaveLength(1);
    }
  }
}, 120_000);

// Real CLI and plugin processes, like the delivery test above: several seconds on a
// loaded machine, past the default five.
it('preserves inherited-property labels through a non-GitHub tracker', () => {
  const host = forgeHost(true);
  const operatorLabels = Object.getOwnPropertyNames(Object.prototype);
  const seeded = JSON.parse(readFileSync(host.statePath, 'utf8')) as {
    issues: { labels: (string | { name: string })[] }[];
    labels: { name: string; color: string; description: string }[];
  };
  seeded.issues[0].labels.push(...operatorLabels);
  seeded.labels.push(...operatorLabels.map(name => ({ name, color: 'abcdef', description: '' })));
  writeFileSync(host.statePath, JSON.stringify(seeded));
  const repo = { host: 'tracker.example', path: 'group/team/project' };
  const inputs = {
    INPUTS_ITEM: JSON.stringify({ repo, number: 7 }),
    INPUTS_PUBLISH: 'true',
    INPUTS_DECISION: JSON.stringify({ contract: 'READY', route: 'deliver' }),
    INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
    INPUTS_SIZE: '{"value":"s","reason":"one script"}',
    INPUTS_COMPLEXITY: '{"value":"low","reason":"clear change"}',
    INPUTS_IMPORTANCE: '{"value":"medium","reason":"on direction"}',
    INPUTS_URGENCY: '{"value":"none","reason":"nothing waits on it"}',
    INPUTS_SUMMARY: 'Ready',
    INPUTS_AREA_LABELS: JSON.stringify(['area', 'nonexistent', 'constructor']),
    INPUTS_RELATED: '[]',
    INPUTS_REPORT: '{"path":"triage.md"}',
  };
  const options = { source: 'forge', forge: { kind: 'command' as const, argv: host.argv } };
  const triage = runPackScript('triage/scripts/verdict', { ...options, inputs });
  expect({ code: triage.code, stderr: triage.stderr }).toMatchObject({ code: 0 });
  expect(triage.gh).toEqual([]);
  expect(JSON.parse(triage.stdout)).toMatchObject({
    published: true,
    labels: ['archon-ready', 'archon-size-s', 'archon-type-feature', 'area', 'constructor'],
  });
  const state = JSON.parse(readFileSync(host.statePath, 'utf8')) as {
    issues: { number: number; labels: (string | { name: string })[] }[];
    labels: { name: string }[];
    writes?: string[];
    calls?: string[];
  };
  const labels = state.issues[0].labels.map(label =>
    typeof label === 'string' ? label : label.name
  );
  expect(labels.sort()).toEqual(
    [
      'archon-ready',
      'archon-size-s',
      'archon-type-feature',
      'area',
      'operator',
      ...operatorLabels,
    ].sort()
  );
  expect(state.labels.some(label => label.name === 'nonexistent')).toBe(false);
}, 120_000);

/** Run `body` with the pack's close and comment writes routed through `host`. */
function throughForge(host: { argv: string[] }, body: () => void): void {
  const saved = { ...process.env };
  Object.assign(process.env, {
    ARCHON_SDLC_FORGE: 'forge',
    ARCHON_CLI_COMMAND: JSON.stringify(host.argv),
  });
  try {
    body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** A plugin-backed host whose state also holds open issues with these numbers. */
function forgeHostWith(...rows: { number: number; pull?: boolean }[]): {
  argv: string[];
  statePath: string;
} {
  const host = forgeHost();
  const seeded = JSON.parse(readFileSync(host.statePath, 'utf8')) as FakeGitHubState;
  for (const row of rows) {
    seeded.issues.push({
      ...seeded.issues[0],
      number: row.number,
      html_url: `https://${FAKE_HOST}/example/repo/${row.pull ? 'pull' : 'issues'}/${String(row.number)}`,
      labels: [],
      ...(row.pull ? { pull_request: {} } : {}),
    });
  }
  writeFileSync(host.statePath, JSON.stringify(seeded));
  return host;
}

it('closes a resolved item through the plugin, linking it to what resolved it and back', () => {
  const host = forgeHostWith({ number: 3 }, { number: 8 });
  const original = { repo: PR.repo, number: 3 };
  const originalUrl = `https://${FAKE_HOST}/example/repo/issues/3`;
  const change = `https://${FAKE_HOST}/example/repo/pull/5`;

  const close = (number: number, closure: Closure): void => {
    const plan = planClose({ repo: PR.repo, number }, closure);
    if (plan.refused !== null) throw new Error(plan.refused);
    plan.close();
  };
  throughForge(host, () => {
    close(7, { kind: 'duplicate', url: originalUrl, original });
    close(8, { kind: 'delivered', url: change });
  });

  const state = JSON.parse(readFileSync(host.statePath, 'utf8')) as FakeGitHubState;
  const closed = (number: number) => state.issues.find(row => row.number === number);
  expect(closed(7)).toMatchObject({ state: 'closed', state_reason: 'duplicate' });
  expect(closed(3)).toMatchObject({ state: 'open' });
  expect(closed(8)).toMatchObject({ state: 'closed', state_reason: 'completed' });
  const expected = [
    ...closeComments({ repo: PR.repo, number: 7 }, `https://${FAKE_HOST}/example/repo/issues/7`, {
      kind: 'duplicate',
      url: originalUrl,
      original,
    }),
    ...closeComments({ repo: PR.repo, number: 8 }, `https://${FAKE_HOST}/example/repo/issues/8`, {
      kind: 'delivered',
      url: change,
    }),
  ];
  expect(state.comments.map(row => ({ number: row.issue, body: row.body }))).toEqual(
    expected.map(comment => ({ number: comment.item.number, body: comment.body }))
  );
  expect(
    state.calls.filter(call => call.startsWith('POST ') && call.endsWith('/comments'))
  ).toEqual(
    expected.map(
      comment =>
        `POST https://${comment.item.repo.host}/api/v3/repos/${comment.item.repo.path}/issues/${comment.item.number}/comments`
    )
  );
}, 120_000);

it('refuses through the plugin to close a duplicate of a pull request', () => {
  const host = forgeHostWith({ number: 5, pull: true });
  const original = { repo: PR.repo, number: 5 };
  const url = `https://${FAKE_HOST}/example/repo/pull/5`;
  const before = readFileSync(host.statePath, 'utf8');

  let plan: ReturnType<typeof planClose> | undefined;
  throughForge(host, () => {
    plan = planClose({ repo: PR.repo, number: 7 }, { kind: 'duplicate', url, original });
  });

  expect(plan?.refused).toContain('is a pull request, not an issue');
  const state = JSON.parse(readFileSync(host.statePath, 'utf8')) as FakeGitHubState;
  const seeded = JSON.parse(before) as FakeGitHubState;
  expect(state.issues).toEqual(seeded.issues);
  expect(state.comments).toEqual([]);
}, 120_000);
