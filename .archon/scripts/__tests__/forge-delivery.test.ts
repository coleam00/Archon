/**
 * The forge opt-in, end to end: the pack's publishing scripts drive the real
 * `archon forge` command, its dispatch and audit, and the real GitHub plugin
 * process, which talks to a fake GitHub (./fake-github-fetch.ts).
 *
 * The other pack tests fake the CLI's answers. This one proves the pieces agree:
 * a delivery creates a draft pull request, updates its body, upserts the same
 * review comment across rounds, reads checks and flips ready, and every one of
 * those steps is an audited plugin operation with no authored content in the
 * audit and no `gh` call at all.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { PR, runPackScript, type ScriptOptions, type ScriptRun } from './deliver-checks-harness';
import { FAKE_HOST, initialState, type FakeGitHubState } from './fake-github-fetch';

const trackTempRoot = trackTempRoots();
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const FORGE_COMMAND = join(REPO_ROOT, 'packages/cli/src/commands/forge.ts');
const GITHUB_PLUGIN = join(REPO_ROOT, 'packages/adapters/src/forge/github/plugin.ts');
const FAKE_GITHUB = join(import.meta.dir, 'fake-github-fetch.ts');

const MARKER = '<!-- archon-review-report -->';
const HEAD_SHA = 'feedface00000000000000000000000000000000';
const OPENING_BODY = 'Opening body: the change adds a guard.';
const RESYNCED_BODY = 'Resynced body: the change adds a guard and its test.';
const ROUND_ONE = 'Round one: one finding still open.';
const ROUND_TWO = 'Round two: every finding resolved.';

/** A host with the GitHub plugin configured for the fake host and a host command. */
function forgeHost(): { argv: string[]; statePath: string; auditLog: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-delivery-')));
  const home = join(root, 'home');
  mkdirSync(home);
  const statePath = join(root, 'github.json');
  const auditLog = join(root, 'audit.jsonl');
  writeFileSync(statePath, JSON.stringify(initialState(HEAD_SHA)));

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
          [FAKE_HOST]: {
            plugin: 'github',
            command: process.execPath,
            args: ['--no-env-file', '--preload', preload, GITHUB_PLUGIN],
          },
        },
      },
    })
  );

  // The host command: the real `archon forge` command function with a trusted
  // Archon home, a run id, and an audit sink standing in for the run's event log.
  const cli = join(root, 'archon.ts');
  writeFileSync(
    cli,
    `import { appendFileSync } from 'node:fs';
import { forgeCommand } from ${JSON.stringify(FORGE_COMMAND)};
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
    audit: async (audit, runId) => {
      appendFileSync(${JSON.stringify(auditLog)}, JSON.stringify({ runId, audit }) + '\\n');
    },
  }
);
`
  );
  return { argv: [process.execPath, '--no-env-file', cli], statePath, auditLog };
}

describe('the forge opt-in delivers through audited plugin operations', () => {
  it(
    'creates a draft, resyncs its body, upserts one review comment, reads checks and flips ready',
    () => {
      const host = forgeHost();
      const through = (relative: string, options: ScriptOptions = {}): ScriptRun => {
        const run = runPackScript(relative, {
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
            INPUTS_READY: String(ready),
            INPUTS_ACTION: ready ? 'none' : 'correct',
            INPUTS_SUMMARY: 'summary',
            INPUTS_REPORT_POINTER: JSON.stringify({ path: 'review/report.md' }),
          },
          artifacts: { 'report.md': report },
        });
      };

      // 1. The draft pull request.
      const created = through('pr/scripts/publish-pr', {
        inputs: { INPUTS_INTENT: '{ARTIFACTS}/pr-intent.json' },
        artifacts: {
          'pr-intent.json': JSON.stringify({
            repo: PR.repo,
            headRepo: PR.repo,
            head: 'feature',
            headRevision: HEAD_SHA,
            base: 'dev',
            title: 'Add a guard',
            bodyPath: '{ARTIFACTS}/pr-body.md',
            draft: true,
          }),
          'pr-body.md': OPENING_BODY,
        },
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
        inputs: { INPUTS_PR: created.stdout, INPUTS_INTENT: '{ARTIFACTS}/intent.json' },
        artifacts: {
          'intent.json': JSON.stringify({ change: true, bodyPath: '{ARTIFACTS}/final.md' }),
          'final.md': RESYNCED_BODY,
        },
      });

      // 4. The second round edits the same comment rather than adding one.
      review(ROUND_TWO, true);

      // 5. The ready flip reads checks, then flips.
      const flipped = through('deliver/scripts/flip-ready');
      expect(JSON.parse(flipped.stdout)).toEqual({ pr_url: record.url });

      const state = github();
      expect(state.pulls).toHaveLength(1);
      expect(state.pulls[0]).toMatchObject({ draft: false, body: RESYNCED_BODY });
      expect(state.comments).toEqual([{ id: 900, body: `${MARKER}\n${ROUND_TWO}` }]);
      const writes = state.calls.filter(call => !call.startsWith('GET '));
      expect(writes.map(call => call.replace(/\?.*$/, ''))).toEqual([
        `POST https://${FAKE_HOST}/api/v3/repos/example/repo/pulls`,
        `POST https://${FAKE_HOST}/api/v3/repos/example/repo/issues/42/comments`,
        `PATCH https://${FAKE_HOST}/api/v3/repos/example/repo/pulls/42`,
        `PATCH https://${FAKE_HOST}/api/v3/repos/example/repo/issues/comments/900`,
        `POST https://${FAKE_HOST}/api/graphql`,
      ]);

      // Every step is an audited plugin operation, and no audit carries what was authored.
      const audits = readFileSync(host.auditLog, 'utf8')
        .split('\n')
        .filter(line => line !== '');
      const operations = audits.map(line => {
        const entry = JSON.parse(line) as {
          runId: string;
          audit: { operation: string; plugin: { name: string } };
        };
        expect(entry.runId).toBe('run-forge-delivery');
        expect(entry.audit.plugin.name).toBe('github');
        return entry.audit.operation;
      });
      expect(operations).toEqual([
        'pr.view',
        'pr.create',
        'comment.upsert',
        'pr.view',
        'pr.edit-body',
        'comment.upsert',
        'checks.state',
        'pr.view',
        'pr.ready',
      ]);
      for (const authored of [OPENING_BODY, RESYNCED_BODY, ROUND_ONE, ROUND_TWO]) {
        expect(audits.some(line => line.includes(authored))).toBe(false);
      }
    },
    120_000
  );
});
