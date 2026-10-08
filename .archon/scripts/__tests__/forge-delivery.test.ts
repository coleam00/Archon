/**
 * The forge opt-in, end to end: the pack's publishing scripts drive the real
 * `archon forge` command, its dispatch, and the real GitHub plugin
 * process, which talks to a fake GitHub (./fake-github-fetch.ts).
 *
 * The other pack tests fake the CLI's answers. This one proves the pieces agree:
 * a delivery creates a draft pull request, updates its body, upserts the same
 * review comment across rounds, flips ready and restores draft, and none of
 * those steps calls `gh`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  forgePrRecord,
  PR,
  gitCheckout,
  runPackScript,
  type ScriptOptions,
  type ScriptRun,
} from './deliver-checks-harness';
import { FAKE_HOST, initialState, type FakeGitHubState } from './fake-github-fetch';

const trackTempRoot = trackTempRoots();
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const FORGE_COMMAND = join(REPO_ROOT, 'packages/cli/src/commands/forge.ts');
const GITHUB_PLUGIN = join(REPO_ROOT, 'packages/adapters/src/forge/github/plugin.ts');
const FAKE_GITHUB = join(import.meta.dir, 'fake-github-fetch.ts');

const MARKER = '<!-- archon-review-report -->';
// A real checkout whose recorded remote is a local bare repository: publish-pr pushes
// it before it creates, and flip-ready merges it against the base.
const CHECKOUT = gitCheckout();
const HEAD_SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT, encoding: 'utf8' }).stdout.trim();
const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });
const OPENING_BODY = 'Opening body: the change adds a guard.';
const RESYNCED_BODY = 'Resynced body: the change adds a guard and its test.';
const ROUND_ONE = `Round one at ${HEAD_SHA}: one finding still open.`;
const ROUND_TWO = `Round two at ${HEAD_SHA}: every finding resolved.`;

/** A host with the GitHub plugin configured for the fake host and a host command. */
function forgeHost(other = false): { argv: string[]; statePath: string } {
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
        : initialState(HEAD_SHA)
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
                  join(import.meta.dir, 'fixtures/workitem-plugin.ts'),
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

describe('the forge opt-in delivers through plugin operations', () => {
  it('creates a draft, resyncs its body, upserts one review comment, flips ready and restores draft', () => {
    const host = forgeHost();
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
          INPUTS_MISSING: '[]',
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
        INPUTS_BODY: '{ARTIFACTS}/pr-body.md',
        INPUTS_DRAFT: 'true',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      },
      artifacts: { 'pr-body.md': OPENING_BODY, 'listing.json': EMPTY_LISTING },
    });
    const record = JSON.parse(created.stdout) as Record<string, unknown>;
    expect(record).toMatchObject({ number: 42, is_draft: true, head_revision: HEAD_SHA });

    // 2. The first review round's canonical comment.
    review(ROUND_ONE, false);

    // 3. The body resync reads the live body, then replaces it.
    const read = through('deliver/scripts/read-pr-body', {
      inputs: { INPUTS_PR: created.stdout },
    });
    const current = JSON.parse(read.stdout) as { body: string };
    expect(readFileSync(current.body, 'utf8')).toBe(OPENING_BODY);
    through('deliver/scripts/publish-pr-body', {
      inputs: {
        INPUTS_PR: created.stdout,
        INPUTS_BODY: JSON.stringify({ type: 'archon_artifact', run_id: 'run', path: 'final.md' }),
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      },
      artifacts: { 'final.md': RESYNCED_BODY, 'listing.json': EMPTY_LISTING },
    });

    // 4. The second round edits the same comment rather than adding one.
    review(ROUND_TWO, true);

    // 5. The ready flip.
    const flipped = through('deliver/scripts/flip-ready', { inputs: { INPUTS_PR: created.stdout } });
    expect(JSON.parse(flipped.stdout)).toEqual({ pr_url: record.url });

    const drafted = through('../../scripts/__tests__/mark-pr-draft');
    expect(JSON.parse(drafted.stdout)).toMatchObject({ is_draft: true, state: 'open' });
    const unchanged = through('../../scripts/__tests__/mark-pr-draft');
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ is_draft: true });

    const state = github();
    expect(state.pulls).toHaveLength(1);
    expect(state.pulls[0]).toMatchObject({ draft: true, body: RESYNCED_BODY });
    expect(state.comments).toEqual([
      { id: 900, body: `${MARKER}\nReviewed commit: \`${HEAD_SHA}\`\n\n${ROUND_TWO}` },
    ]);
    const writes = state.calls.filter(call => !call.startsWith('GET '));
    expect(writes.map(call => call.replace(/\?.*$/, ''))).toEqual([
      `POST https://${FAKE_HOST}/api/v3/repos/example/repo/pulls`,
      `POST https://${FAKE_HOST}/api/v3/repos/example/repo/issues/42/comments`,
      `PATCH https://${FAKE_HOST}/api/v3/repos/example/repo/pulls/42`,
      `PATCH https://${FAKE_HOST}/api/v3/repos/example/repo/issues/comments/900`,
      `POST https://${FAKE_HOST}/api/graphql`,
      `POST https://${FAKE_HOST}/api/graphql`,
    ]);
  }, 120_000);
});

for (const other of [false, true]) {
  it(`preserves inherited-property labels and publishes marker-idempotent discoveries through ${other ? 'a non-GitHub tracker' : 'GitHub'}`, () => {
    const host = forgeHost(other);
    const operatorLabels = Object.getOwnPropertyNames(Object.prototype);
    const seeded = JSON.parse(readFileSync(host.statePath, 'utf8')) as {
      issues: { labels: (string | { name: string })[] }[];
      labels: { name: string; color: string; description: string }[];
    };
    seeded.issues[0].labels.push(...operatorLabels.map(name => (other ? name : { name })));
    seeded.labels.push(...operatorLabels.map(name => ({ name, color: 'abcdef', description: '' })));
    writeFileSync(host.statePath, JSON.stringify(seeded));
    const repo = other ? { host: 'tracker.example', path: 'group/team/project' } : PR.repo;
    const inputs = {
      INPUTS_ITEM: JSON.stringify({ repo, number: 7 }),
      INPUTS_PUBLISH: 'true',
      INPUTS_DECISION: JSON.stringify({ contract: 'READY', route: 'deliver', design_first: false }),
      INPUTS_COMPLEXITY: 'small',
      INPUTS_SUMMARY: 'Ready',
      INPUTS_AREA_LABELS: JSON.stringify(['area', 'nonexistent', 'constructor']),
      INPUTS_REPORT: '{"path":"triage.md"}',
    };
    const options = { source: 'forge', forge: { kind: 'command' as const, argv: host.argv } };
    const triage = runPackScript('triage/scripts/verdict', { ...options, inputs });
    expect({ code: triage.code, stderr: triage.stderr }).toMatchObject({ code: 0 });
    expect(triage.gh).toEqual([]);
    expect(JSON.parse(triage.stdout)).toMatchObject({
      published: true,
      labels: ['archon-ready', 'archon-small', 'area', 'constructor'],
    });
    const record = {
      title: 'Proved discovery',
      claim: 'Concrete claim',
      evidence: ['file:12'],
      relation: 'unrelated',
      source_nodes: ['review'],
    };
    const discovery = (runId: string): ScriptRun =>
      runPackScript('deliver/scripts/file-discoveries', {
        ...options,
        inputs: {
          INPUTS_PR: JSON.stringify(forgePrRecord({ repo })),
          INPUTS_INITIAL: JSON.stringify([record]),
          INPUTS_FINAL: 'null',
          INPUTS_MATCHES: '[]',
          WORKFLOW_ID: runId,
        },
      });
    // Two runs, two empty ledgers: the second create is recovered by its body marker.
    const first = discovery('first');
    const second = discovery('second');
    for (const result of [first, second]) {
      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.gh).toEqual([]);
      const saved = JSON.parse(
        readFileSync(join(result.artifacts, 'discoveries-filed.json'), 'utf8')
      ) as Record<string, string>;
      expect(Object.values(saved)).toEqual([JSON.parse(result.stdout).records[0].issue]);
    }
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    const state = JSON.parse(readFileSync(host.statePath, 'utf8')) as {
      issues: { number: number; labels: (string | { name: string })[] }[];
      labels: { name: string }[];
      writes?: string[];
      calls?: string[];
    };
    expect(state.issues).toHaveLength(2);
    const labels = state.issues[0].labels.map(label =>
      typeof label === 'string' ? label : label.name
    );
    expect(labels.sort()).toEqual(
      ['archon-ready', 'archon-small', 'area', 'operator', ...operatorLabels].sort()
    );
    expect(state.labels.some(label => label.name === 'nonexistent')).toBe(false);
    const writes = other
      ? state.writes?.filter(op => op === 'workitem.create')
      : state.calls?.filter(call => call.startsWith('POST ') && call.includes('/issues'));
    expect(writes).toHaveLength(1);
  });
}
