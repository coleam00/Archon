import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  forgeOperation,
  forgePrRecord,
  gitCheckout,
  packScriptRunner,
  PR,
  PR_URL,
  type ScriptOptions,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();
const HEAD = 'deadbeef';
const execution = (head: string) =>
  JSON.stringify({ attempt: { checkoutStart: { kind: 'git', commit: head } } });

function check(options: ScriptOptions = {}) {
  const cwd = options.cwd ?? gitCheckout({}, track);
  return runPackScript('review/scripts/check-review-head', {
    ...options,
    cwd,
    inputs: {
      INPUTS_SCOPE: PR_URL,
      INPUTS_SELECTOR: PR_URL,
      INPUTS_HEAD: HEAD,
      ARCHON_NODE_EXECUTION: execution(HEAD),
      ...options.inputs,
    },
  });
}

/** The PR and base branch a passing check hands to publication. */
const PR_TARGET = { pr: PR, base: 'dev' };

function view(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'fake',
    response: forgeOperation('pr.view', { pr: forgePrRecord(overrides) }),
  } as const;
}

describe('review head boundary', () => {
  for (const source of ['gh', 'forge']) {
    it(`accepts a matching live head through ${source}`, () => {
      const cwd = gitCheckout({}, track);
      const run = check({ cwd, source, forge: view() });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(PR_TARGET);
    });
    it(`refuses a different live head through ${source} before lenses, with retry commands`, () => {
      const cwd = gitCheckout({}, track);
      const run = check({
        cwd,
        source,
        gh: { pr: { headRefOid: 'newhead' } },
        forge: view({ head_revision: 'newhead' }),
      });
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(`${PR.repo.host}/${PR.repo.path}#42`);
      expect(run.stderr).toContain(HEAD);
      expect(run.stderr).toContain('newhead');
      expect(run.stderr).toContain(
        `archon workflow run archon-review --branch 'feature' --input 'scope=${PR_URL}'`
      );
      expect(run.stderr).toContain("git fetch -- 'upstream' 'refs/pull/42/head'");
      expect(run.stderr).toContain(`--from 'newhead' --input 'scope=${PR_URL}'`);
      expect(run.stderr).toContain('No review lenses ran');
    });
  }

  for (const source of ['gh', 'forge']) {
    for (const fork of [false, true]) {
      for (const failure of ['ambiguous', 'config']) {
        it(`retains the mismatch and pinned retry for ${source}, ${fork ? 'fork' : 'same-repository'} head, and ${failure} remotes`, () => {
          const cwd = gitCheckout({}, track);
          const headRepo = fork ? { ...PR.repo, path: 'contributor/repo' } : PR.repo;
          if (failure === 'ambiguous') {
            git(cwd, 'remote', 'add', 'alias', `https://${PR.repo.host}/${PR.repo.path}.git`);
          } else {
            writeFileSync(join(cwd, '.git/config'), '[broken');
          }
          const run = check({
            cwd,
            source,
            gh: {
              pr: {
                headRefOid: 'newhead',
                headRepository: { name: 'repo' },
                headRepositoryOwner: { login: fork ? 'contributor' : 'example' },
              },
            },
            forge: view({ head_revision: 'newhead', head_repo: headRepo }),
          });
          expect(run.code).toBe(1);
          expect(run.stderr).toContain(`${PR.repo.host}/${PR.repo.path}#42`);
          expect(run.stderr).toContain(HEAD);
          expect(run.stderr).toContain('newhead');
          expect(run.stderr).toContain(
            `git fetch -- 'https://${PR.repo.host}/${PR.repo.path}.git' 'refs/pull/42/head'`
          );
          expect(run.stderr).toContain(
            `archon workflow run archon-review --from 'newhead' --input 'scope=${PR_URL}'`
          );
          expect(run.stderr).toContain(
            failure === 'ambiguous' ? 'several git remotes' : 'git config --get-regexp failed'
          );
        });
      }
    }
  }

  for (const scope of [PR_URL, JSON.stringify(PR)]) {
    it(`refuses a substituted forge identity: ${scope}`, () => {
      const run = check({
        source: 'forge',
        forge: view({ number: 99 }),
        inputs: { INPUTS_SCOPE: scope },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('does not match');
    });
  }

  it('rejects a substituted GitHub identity', () => {
    const run = check({ gh: { pr: { number: 99 } } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('does not match');
  });

  for (const remotes of ['none', 'local', 'fork']) {
    it(`allows an empty-scope working diff with ${remotes} remotes`, () => {
      const cwd = gitCheckout({}, track);
      if (remotes === 'fork')
        git(cwd, 'remote', 'add', 'fork', 'https://ghe.example.com/fork/repo.git');
      else {
        git(cwd, 'remote', 'remove', 'upstream');
        if (remotes === 'local') git(cwd, 'remote', 'add', 'local', '/tmp/local-repository');
      }
      const run = check({
        cwd,
        gh: { noOpenPr: true },
        inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ pr: null, base: null });
      expect(run.stderr).toContain('working diff');
    });
  }

  for (const source of ['gh', 'forge']) {
    it(`reviews the working diff with a note when ${source} cannot query the remote and nothing names a PR`, () => {
      const run = check({
        source,
        gh: { listFail: 'none of the git remotes configured point to a known GitHub host' },
        forge: { kind: 'fake' },
        inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ pr: null, base: null });
      expect(run.stderr).toContain(
        `Open-PR discovery could not query ${PR.repo.host}/${PR.repo.path}: `
      );
      expect(run.stderr).toContain(source === 'gh' ? 'known GitHub host' : 'plugin unavailable');
    });
  }

  it('still refuses an explicit PR the forge cannot query', () => {
    const run = check({ source: 'forge', forge: { kind: 'fake' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('plugin unavailable');
  });

  it('keeps a PR one remote answers for when another remote cannot be queried', () => {
    const cwd = gitCheckout({}, track);
    const fork = { ...PR.repo, path: 'contributor/repo' };
    git(cwd, 'remote', 'add', 'fork', `https://${fork.host}/${fork.path}.git`);
    const failed = JSON.stringify({ operationId: 'op', ok: false, error: 'unreachable' });
    const run = check({
      cwd,
      source: 'forge',
      inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', { pr: forgePrRecord() }),
          failed,
          failed,
          failed,
        ],
      },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(PR_TARGET);
    expect(run.stderr).toContain('Open-PR discovery could not query');
  });

  it('discovers a unique fork PR across upstream and fork remotes', () => {
    const cwd = gitCheckout({}, track);
    const fork = { ...PR.repo, path: 'contributor/repo' };
    git(cwd, 'remote', 'add', 'fork', `https://${fork.host}/${fork.path}.git`);
    const absent = forgeOperation('pr.view', null);
    const run = check({
      cwd,
      source: 'forge',
      inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
      forge: {
        kind: 'fake',
        response: [
          absent,
          forgeOperation('pr.view', { pr: forgePrRecord({ head_repo: fork }) }),
          absent,
          absent,
        ],
      },
    });
    expect(run.code).toBe(0);
    expect(run.forgeRequests.map(value => JSON.parse(value).selector)).toContainEqual({
      kind: 'head',
      repo: PR.repo,
      headRepo: fork,
      head: 'feature',
    });
  });

  it('requires an explicit selector when empty-scope discovery finds several PRs', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'add', 'fork', 'https://ghe.example.com/contributor/repo.git');
    const run = check({
      cwd,
      inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('more than one open pull request matches');
  });

  it('checks the live revision instead of the stale recorded revision', () => {
    const run = check({
      inputs: { INPUTS_SCOPE: JSON.stringify(forgePrRecord({ head_revision: 'stale' })) },
    });
    expect(run.code).toBe(0);
    expect(run.gh).toHaveLength(1);
  });

  it('binds an explicit target when the agent substitutes a matching different PR', () => {
    const run = check({
      source: 'forge',
      forge: view({ number: 99, url: PR_URL.replace('/42', '/99') }),
      inputs: { INPUTS_SELECTOR: PR_URL.replace('/42', '/99') },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('does not match');
    expect(JSON.parse(run.forgeRequests[0]).selector).toEqual({ kind: 'number', ref: PR });
  });

  it('resolves the recorded delivery JSON in both scope and selector by number', () => {
    const recorded = JSON.stringify(forgePrRecord({ head_revision: 'stale' }));
    const run = check({
      source: 'forge',
      forge: view(),
      inputs: { INPUTS_SCOPE: recorded, INPUTS_SELECTOR: recorded },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.forgeRequests[0]).selector).toEqual({ kind: 'number', ref: PR });
  });

  it('refuses a checkout that moved since mode without consulting the forge', () => {
    const run = check({ inputs: { ARCHON_NODE_EXECUTION: execution('moved') } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`fixed ${HEAD}, but the checkout is now at moved`);
    expect(run.gh).toEqual([]);
  });

  for (const source of ['gh', 'forge']) {
    it(`does not let scope erase an explicit PR target through ${source}`, () => {
      const cwd = gitCheckout({}, track);
      const run = check({
        cwd,
        source,
        gh: { noOpenPr: true, pr: { headRefOid: 'anotherhead' } },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
        inputs: { INPUTS_SCOPE: PR_URL, INPUTS_SELECTOR: '' },
      });
      expect(run.code).toBe(1);
      if (source === 'gh') {
        expect(run.stderr).toContain('anotherhead');
        expect(run.stderr).toContain(`--from 'anotherhead' --input 'scope=${PR_URL}'`);
      } else {
        expect(run.stderr).toContain('forge pr.view returned no result');
        expect(JSON.parse(run.forgeRequests[0]).selector).toEqual({ kind: 'number', ref: PR });
      }
      expect(run.stdout).not.toContain('working diff');
    });

    for (const scope of ['42', PR_URL, 'feature', '']) {
      for (const matching of [true, false]) {
        it(`resolves standalone scope ${JSON.stringify(scope)} through ${source} with ${matching ? 'a matching' : 'another'} head`, () => {
          const cwd = gitCheckout({}, track);
          const remoteHead = matching ? HEAD : 'anotherhead';
          const run = check({
            cwd,
            source,
            forge: view({ head_revision: remoteHead }),
            gh: { pr: { headRefOid: remoteHead } },
            inputs: { INPUTS_SCOPE: scope, INPUTS_SELECTOR: scope },
          });
          expect(run.code).toBe(matching ? 0 : 1);
          if (matching) expect(JSON.parse(run.stdout)).toEqual(PR_TARGET);
          else {
            expect(run.stderr).toContain(`the checkout is at ${HEAD}, but`);
            expect(run.stderr).toContain(
              `archon workflow run archon-review --from 'anotherhead' --input 'scope=${PR_URL}'`
            );
          }
          if (source === 'forge') {
            const selector = JSON.parse(run.forgeRequests[0]).selector;
            expect(run.forgeRequests).toHaveLength(1);
            expect(selector).toEqual(
              scope === '' || scope === 'feature'
                ? { kind: 'head', repo: PR.repo, headRepo: PR.repo, head: 'feature' }
                : { kind: 'number', ref: PR }
            );
          } else {
            expect(run.gh).toHaveLength(1);
            expect(run.gh[0]).toContain(
              scope === '' || scope === 'feature'
                ? 'pr list --repo ghe.example.com/example/repo --head feature'
                : 'pr view 42 --repo ghe.example.com/example/repo'
            );
          }
        });
      }
    }

    it(`accepts a verified working diff through ${source}`, () => {
      const cwd = gitCheckout({}, track);
      const run = check({
        cwd,
        source,
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
        inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '' },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ pr: null, base: null });
    });
  }

  it('refuses a number selector when remotes name several repositories', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'add', 'fork', 'https://ghe.example.com/fork/repo.git');
    const run = check({ cwd, inputs: { INPUTS_SCOPE: '42', INPUTS_SELECTOR: '42' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--input scope=<full-PR-URL>');
    expect(run.gh).toEqual([]);
  });

  it('does not turn an unresolved branch into a working diff', () => {
    const cwd = gitCheckout({}, track);
    const run = check({
      cwd,
      gh: { noOpenPr: true },
      inputs: { INPUTS_SCOPE: 'feature', INPUTS_SELECTOR: 'feature' },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no open pull request');
  });

  for (const state of ['open', 'closed', 'merged'] as const) {
    for (const headRepo of [PR.repo, { ...PR.repo, path: 'contributor/repo' }, null]) {
      for (const kind of ['pull', '-/merge_requests']) {
        it(`recovers an unknown head for ${state}, ${JSON.stringify(headRepo)}, ${kind}`, () => {
          const cwd = gitCheckout({}, track);
          const head = git(cwd, 'rev-parse', 'HEAD');
          const ref = kind === 'pull' ? 'refs/pull/42/head' : 'refs/merge-requests/42/head';
          git(cwd, 'push', '-q', 'upstream', `HEAD:${ref}`);
          const url = `https://${PR.repo.host}/${PR.repo.path}/${kind}/42`;
          const options: ScriptOptions = {
            cwd,
            source: 'forge',
            forge: view({ state, head_repo: headRepo, head_revision: null, url }),
            inputs: { INPUTS_SCOPE: url, INPUTS_SELECTOR: url },
          };
          const refused = check(options);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(`git fetch -- 'upstream' '${ref}'`);
          expect(refused.stderr).toContain(`--from '${head}'`);
          expect(refused.stderr).not.toContain('--branch');
          git(cwd, 'fetch', '--', 'upstream', ref);
          expect(git(cwd, 'rev-parse', 'FETCH_HEAD')).toBe(head);
          const retried = check({
            ...options,
            inputs: {
              ...options.inputs,
              INPUTS_HEAD: head,
              ARCHON_NODE_EXECUTION: execution(head),
            },
          });
          expect(retried.code).toBe(0);
        });
      }
    }
  }

  it('uses the GitLab retained ref for an alternate-view forge record and URL scope', () => {
    const cwd = gitCheckout({}, track);
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'HEAD:refs/merge-requests/42/head');
    const url = `https://${PR.repo.host}/${PR.repo.path}/-/merge_requests/42/diffs`;
    for (const scope of [JSON.stringify(PR), url]) {
      const options: ScriptOptions = {
        cwd,
        source: 'forge',
        forge: view({ url, head_revision: null }),
        inputs: { INPUTS_SCOPE: scope },
      };
      const refused = check(options);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("git fetch -- 'upstream' 'refs/merge-requests/42/head'");
      expect(refused.stderr).toContain(`--from '${head}'`);
      expect(refused.stderr).not.toContain('refs/pull/');
      expect(
        check({
          ...options,
          inputs: { ...options.inputs, INPUTS_HEAD: head, ARCHON_NODE_EXECUTION: execution(head) },
        }).code
      ).toBe(0);
    }
  });

  it('refuses an unsupported forge PR URL instead of guessing a retained ref', () => {
    const run = check({
      source: 'forge',
      forge: view({
        url: `https://${PR.repo.host}/${PR.repo.path}/unknown/42`,
        head_revision: null,
      }),
      inputs: { INPUTS_SCOPE: JSON.stringify(PR) },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('unsupported PR URL');
    expect(run.stderr).not.toContain('refs/pull/');
  });

  it('refuses an unknown head with a missing retained ref without an unusable retry', () => {
    const cwd = gitCheckout({}, track);
    const run = check({
      cwd,
      source: 'forge',
      forge: view({ head_revision: null, head_repo: null }),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('unknown head');
    expect(run.stderr).toContain('refs/pull/42/head');
    expect(run.stderr).toContain('Restore');
    expect(run.stderr).not.toContain('archon workflow run');
  });

  it('preserves a forge read failure without falling back to gh', () => {
    const run = check({ source: 'forge', forge: { kind: 'fake' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('plugin unavailable');
    expect(run.gh).toEqual([]);
  });

  it('fetches fork heads from the base remote and hides remote credentials', () => {
    const cwd = gitCheckout({}, track);
    git(
      cwd,
      'remote',
      'set-url',
      'upstream',
      'https://secret:password@ghe.example.com/example/repo.git'
    );
    const run = check({
      cwd,
      source: 'forge',
      forge: view({
        head_repo: { ...PR.repo, path: 'contributor/repo' },
        head: "fix/it's",
        head_revision: 'forksha',
      }),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("git fetch -- 'upstream' 'refs/pull/42/head'");
    expect(run.stderr).toContain("--from 'forksha'");
    expect(run.stderr).not.toContain('--branch');
    expect(run.stderr).not.toContain('password');
    expect(run.stderr).not.toContain('secret');
  });

  it('uses the base repository URL when no configured remote names it', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'set-url', 'upstream', 'https://other.example.com/other/repo.git');
    const run = check({
      cwd,
      source: 'forge',
      forge: view({
        head_repo: { host: 'git.example.com', path: 'fork/project' },
        head_revision: 'forksha',
      }),
    });
    expect(run.stderr).toContain("git fetch -- 'https://ghe.example.com/example/repo.git'");
  });

  for (const state of ['closed', 'merged'] as const) {
    for (const fork of [false, true]) {
      it(`recovers a ${state} PR with a deleted ${fork ? 'fork' : 'same-repository'} branch`, () => {
        const cwd = gitCheckout({}, track);
        const head = git(cwd, 'rev-parse', 'HEAD');
        git(cwd, 'push', '-q', 'upstream', 'HEAD:refs/pull/42/head');
        const run = check({
          cwd,
          source: 'forge',
          forge: view({
            state,
            head_revision: head,
            head_repo: fork ? { ...PR.repo, path: 'contributor/repo' } : PR.repo,
          }),
        });
        expect(run.code).toBe(1);
        expect(run.stderr).not.toContain('--branch');
        expect(run.stderr).toContain("git fetch -- 'upstream' 'refs/pull/42/head'");
        expect(run.stderr).toContain(`--from '${head}'`);
        git(cwd, 'fetch', '--', 'upstream', 'refs/pull/42/head');
        expect(git(cwd, 'rev-parse', 'FETCH_HEAD')).toBe(head);
      });
    }
  }

  for (const state of ['open', 'closed', 'merged'] as const) {
    for (const sourceRepo of ['same', 'fork', 'missing'] as const) {
      const suffix = state === 'open' && sourceRepo === 'same' ? '/' : '';
      it(`fetches a GitLab retained head: ${state}, ${sourceRepo} source, suffix ${JSON.stringify(suffix)}`, () => {
        const cwd = gitCheckout({}, track);
        const head = git(cwd, 'rev-parse', 'HEAD');
        git(cwd, 'push', '-q', 'upstream', 'HEAD:refs/merge-requests/42/head');
        const url = `https://${PR.repo.host}/${PR.repo.path}/-/merge_requests/42${suffix}`;
        const run = check({
          cwd,
          source: 'forge',
          forge: view({
            url,
            state,
            head_revision: head,
            head_repo:
              sourceRepo === 'missing'
                ? null
                : sourceRepo === 'fork'
                  ? { ...PR.repo, path: 'contributor/repo' }
                  : PR.repo,
          }),
          inputs: { INPUTS_SCOPE: url, INPUTS_SELECTOR: url },
        });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("git fetch -- 'upstream' 'refs/merge-requests/42/head'");
        expect(run.stderr).toContain(`--from '${head}' --input 'scope=${url}'`);
        expect(run.stderr.includes('--branch')).toBe(state === 'open' && sourceRepo === 'same');
        git(cwd, 'fetch', '--', 'upstream', 'refs/merge-requests/42/head');
        expect(git(cwd, 'rev-parse', 'FETCH_HEAD')).toBe(head);
      });
    }
  }

  it('pins the fetched head even when setup later fetches the base', () => {
    const cwd = gitCheckout({}, track);
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'HEAD:refs/pull/42/head');
    const run = check({ cwd, source: 'forge', forge: view({ head_revision: head }) });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`--from '${head}'`);
    git(cwd, 'fetch', '--', 'upstream', 'refs/pull/42/head');
    git(cwd, 'fetch', 'upstream', 'dev');
    expect(git(cwd, 'rev-parse', 'FETCH_HEAD')).not.toBe(head);
    const review = join(cwd, '..', 'review');
    git(cwd, 'worktree', 'add', '-q', '-b', 'review', review, head);
    expect(git(review, 'rev-parse', 'HEAD')).toBe(head);
  });
});

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

import { dryRunWorkflow, dryRunStubsSchema } from '../../../packages/workflows/src/dry-run';
import { discoverWorkflows } from '../../../packages/workflows/src/workflow-discovery';

const REPO = resolve(import.meta.dir, '../../..');

describe('PR review scheduling with the real head check', () => {
  for (const continuation of [false, true]) {
    for (const scenario of [
      'matching',
      'mismatch',
      'erased-selector',
      'message-pr',
      'message-pr-matching',
      'message-pr-no-ambient',
    ]) {
      const matching = scenario === 'matching' || scenario === 'message-pr-matching';
      const override = scenario.startsWith('message-pr');
      const target = override ? { ...PR, number: 99 } : PR;
      const selector = override ? PR_URL.replace('/42', '/99') : PR_URL;
      it(`${continuation ? 'continuation' : 'initial'} review ${scenario}`, async () => {
        const cwd = gitCheckout({}, track);
        const head = git(cwd, 'rev-parse', 'HEAD');
        const root = track(mkdtempSync(join(tmpdir(), 'archon-head-graph-')));
        const cli = join(root, 'forge.ts');
        writeFileSync(
          cli,
          `import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] !== 'forge' || argv[1] !== 'pr.view') throw new Error('unexpected operation');
const request = JSON.parse(readFileSync(argv[argv.indexOf('--data-file') + 1], 'utf8'));
const response = request.selector.kind === 'number' && request.selector.ref.number === ${target.number}
  ? ${JSON.stringify(forgeOperation('pr.view', { pr: forgePrRecord({ number: target.number, url: selector, head_revision: matching ? head : 'anotherhead' }) }))}
  : ${JSON.stringify(forgeOperation('pr.view', scenario === 'erased-selector' || scenario.startsWith('message-pr-no-ambient') ? null : { pr: forgePrRecord({ head_revision: head }) }))};
console.log(response);
`
        );
        const priorEnv = {
          ARCHON_HOME: process.env.ARCHON_HOME,
          ARCHON_SDLC_FORGE: process.env.ARCHON_SDLC_FORGE,
          ARCHON_CLI_COMMAND: process.env.ARCHON_CLI_COMMAND,
        };
        Object.assign(process.env, {
          ARCHON_HOME: join(root, 'home'),
          ARCHON_SDLC_FORGE: 'forge',
          ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]),
        });
        try {
          const discovered = await discoverWorkflows(REPO, {
            providers: { get: () => undefined, list: () => [] },
          });
          const workflow = discovered.workflows.find(
            entry => entry.workflow.name === 'archon-review'
          )?.workflow;
          if (!workflow) throw new Error(JSON.stringify(discovered.errors));
          const parsed: unknown = Bun.YAML.parse(
            readFileSync(
              join(REPO, '.archon/workflows/sdlc/review/fixtures/lenses-selected.stubs.yaml'),
              'utf8'
            )
          );
          const stubs = dryRunStubsSchema.parse(parsed);
          delete stubs.fixture;
          delete stubs['head-check'];
          stubs.mode = {
            continuation,
            light: false,
            head,
            cursor: continuation ? head : '',
            risks: 'fixture',
            execution: {},
            part: null,
            seams: continuation,
            code: continuation,
            tests: false,
            errors: false,
            docs: continuation,
          };
          // The scope agent declares no PR; head-check resolves it from the inputs.
          stubs.scope = {
            selector: scenario === 'erased-selector' ? '' : selector,
            report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'review/scope.md' },
          };
          const result = await dryRunWorkflow({
            workflow,
            cwd: REPO,
            execWorkspace: cwd,
            execCode: true,
            userMessage: override ? 'Review PR 99 instead' : 'Review this PR',
            inputs: { scope: override ? '' : PR_URL },
            stubs,
          });
          const states = new Map(result.trace.map(entry => [entry.nodeId, entry.state]));
          expect(states.get('head-check')).toBe(matching ? 'completed' : 'failed');
          if (matching) {
            for (const node of ['seams', 'code', 'docs', 'synthesize', 'publish'])
              expect(states.get(node)).toBe('stubbed');
            expect(states.get('route')).toBe('stubbed');
          } else {
            for (const node of [
              'route',
              'seams',
              'code',
              'tests',
              'errors',
              'docs',
              'synthesize',
              'publish',
            ])
              expect(states.get(node)).toBe('skipped');
            const reason = result.trace.find(entry => entry.nodeId === 'head-check')?.reason;
            expect(reason).toContain(`the checkout is at ${head}, but`);
            expect(reason).toContain(
              `archon workflow run archon-review --branch 'feature' --input 'scope=${selector}'`
            );
            expect(reason).toContain(
              `archon workflow run archon-review --from 'anotherhead' --input 'scope=${selector}'`
            );
          }
        } finally {
          for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      });
    }
  }
});

describe('delivery rereview checks the recorded PR after reshape', () => {
  for (const scenario of ['matching', 'mismatch']) {
    it(`gates rereview lenses, publication and CI with ${scenario}`, async () => {
      const cwd = gitCheckout({}, track);
      const head = git(cwd, 'rev-parse', 'HEAD');
      const root = track(mkdtempSync(join(tmpdir(), 'archon-rereview-graph-')));
      const cli = join(root, 'forge.ts');
      const log = join(root, 'forge.log');
      writeFileSync(
        cli,
        `import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n');
if (argv[0] !== 'forge' || argv[1] !== 'pr.view') throw new Error('unexpected operation');
console.log(${JSON.stringify(forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: scenario === 'mismatch' ? 'anotherhead' : head }) }))});
`
      );
      const priorEnv = {
        ARCHON_HOME: process.env.ARCHON_HOME,
        ARCHON_SDLC_FORGE: process.env.ARCHON_SDLC_FORGE,
        ARCHON_CLI_COMMAND: process.env.ARCHON_CLI_COMMAND,
      };
      Object.assign(process.env, {
        ARCHON_HOME: join(root, 'home'),
        ARCHON_SDLC_FORGE: 'forge',
        ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]),
      });
      try {
        const discovered = await discoverWorkflows(REPO, {
          providers: { get: () => undefined, list: () => [] },
        });
        const workflow = discovered.workflows.find(
          entry => entry.workflow.name === 'archon-deliver'
        )?.workflow;
        if (!workflow) throw new Error(JSON.stringify(discovered.errors));
        const stubs = dryRunStubsSchema.parse(
          Bun.YAML.parse(
            readFileSync(
              join(REPO, '.archon/workflows/sdlc/deliver/fixtures/ready.stubs.yaml'),
              'utf8'
            )
          )
        );
        delete stubs.fixture;
        delete stubs['rereview__head-check'];
        stubs['pr__publish'] = forgePrRecord({ head_revision: 'before-reshape' });
        stubs['rereview__mode'] = {
          continuation: true,
          light: true,
          head,
          cursor: 'before-reshape',
          risks: 'fixture',
          execution: {},
          part: null,
          seams: false,
          code: true,
          tests: false,
          errors: false,
          docs: false,
        };
        stubs['rereview__scope'] = {
          selector: PR_URL,
          report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'review/scope.md' },
        };
        const result = await dryRunWorkflow({
          workflow,
          cwd: REPO,
          execWorkspace: cwd,
          execCode: true,
          userMessage: 'Deliver this work',
          stubs,
        });
        const states = new Map(result.trace.map(entry => [entry.nodeId, entry.state]));
        expect(states.get('reshape__implement')).toBe('stubbed');
        expect(states.get('rereview__head-check')).toBe(
          scenario === 'matching' ? 'completed' : 'failed'
        );
        for (const node of ['rereview__code', 'rereview__synthesize', 'rereview__publish', 'ci'])
          expect(states.get(node)).toBe(scenario === 'matching' ? 'stubbed' : 'skipped');
        for (const lens of ['seams', 'tests', 'errors', 'docs'])
          expect(states.get(`rereview__${lens}`)).toBe('skipped');
        expect(readFileSync(log, 'utf8')).toContain('pr.view');
        if (scenario === 'mismatch')
          expect(
            result.trace.find(entry => entry.nodeId === 'rereview__head-check')?.reason
          ).toContain('anotherhead');
      } finally {
        for (const [key, value] of Object.entries(priorEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
});
