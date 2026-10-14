import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  return runPackScript('review/scripts/check-review-head', {
    ...options,
    inputs: {
      INPUTS_SCOPE: PR_URL,
      INPUTS_SELECTOR: PR_URL,
      INPUTS_PR: JSON.stringify(PR),
      INPUTS_HEAD: HEAD,
      ARCHON_NODE_EXECUTION: execution(HEAD),
      ...options.inputs,
    },
  });
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'fake',
    response: forgeOperation('pr.view', { pr: forgePrRecord(overrides) }),
  } as const;
}

describe('review head boundary', () => {
  for (const source of ['gh', 'forge']) {
    it(`accepts a matching live head through ${source}`, () => {
      const run = check({ source, forge: view() });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('matches the commit');
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
      expect(run.stderr).toContain("git fetch -- 'upstream' 'refs/heads/feature'");
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
            git(cwd, 'remote', 'add', 'alias', `https://${headRepo.host}/${headRepo.path}.git`);
            if (fork)
              git(
                cwd,
                'remote',
                'add',
                'contributor',
                `https://${headRepo.host}/${headRepo.path}.git`
              );
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
            `git fetch -- 'https://${headRepo.host}/${headRepo.path}.git' 'refs/heads/feature'`
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

  it('checks the live revision instead of the stale recorded revision', () => {
    const run = check({
      inputs: { INPUTS_SCOPE: JSON.stringify(forgePrRecord({ head_revision: 'stale' })) },
    });
    expect(run.code).toBe(0);
    expect(run.gh).toHaveLength(1);
  });

  it('refuses a checkout that moved since mode without consulting the forge', () => {
    const run = check({ inputs: { ARCHON_NODE_EXECUTION: execution('moved') } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`fixed ${HEAD}, but the checkout is now at moved`);
    expect(run.gh).toEqual([]);
  });

  for (const declared of ['null', JSON.stringify({ ...PR, number: 99 })]) {
    it(`refuses a recorded target with a conflicting declaration ${declared}`, () => {
      const run = check({
        inputs: { INPUTS_SCOPE: JSON.stringify(forgePrRecord()), INPUTS_PR: declared },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('does not match');
      expect(run.gh).toEqual([]);
    });
  }

  for (const source of ['gh', 'forge']) {
    for (const scope of ['42', PR_URL, 'feature', '']) {
      for (const declaration of ['matching', 'null', 'wrong', 'mismatch']) {
        it(`resolves standalone scope ${JSON.stringify(scope)} through ${source} with ${declaration} declaration`, () => {
          const cwd = gitCheckout({}, track);
          const run = check({
            cwd,
            source,
            forge: view({ head_revision: declaration === 'matching' ? HEAD : 'anotherhead' }),
            gh: { pr: { headRefOid: declaration === 'matching' ? HEAD : 'anotherhead' } },
            inputs: {
              INPUTS_SCOPE: scope,
              INPUTS_SELECTOR: scope,
              INPUTS_PR: JSON.stringify(
                declaration === 'null' ? null : declaration === 'wrong' ? { ...PR, number: 99 } : PR
              ),
            },
          });
          expect(run.code).toBe(declaration === 'matching' ? 0 : 1);
          if (declaration === 'mismatch') expect(run.stderr).toContain('anotherhead');
          else if (declaration !== 'matching') {
            expect(run.stderr).toContain('does not match');
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
        inputs: { INPUTS_SCOPE: '', INPUTS_SELECTOR: '', INPUTS_PR: 'null' },
      });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('working diff');
    });
  }

  it('refuses an ambiguous repository before trusting the declaration', () => {
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
      inputs: { INPUTS_SCOPE: 'feature', INPUTS_SELECTOR: 'feature', INPUTS_PR: 'null' },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no open pull request');
  });

  it('refuses unknown head facts without inventing a pinned retry', () => {
    const run = check({ source: 'forge', forge: view({ head_revision: null, head_repo: null }) });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('an unknown head');
    expect(run.stderr).toContain('Restore resolution');
    expect(run.stderr).not.toContain('--from');
  });

  it('preserves a forge read failure without falling back to gh', () => {
    const run = check({ source: 'forge', forge: { kind: 'fake' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('plugin unavailable');
    expect(run.gh).toEqual([]);
  });

  it('quotes the fork branch, selects its own remote, and hides remote credentials', () => {
    const cwd = gitCheckout({}, track);
    git(
      cwd,
      'remote',
      'add',
      'contributor',
      'https://secret:password@ghe.example.com/contributor/repo.git'
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
    expect(run.stderr).toContain("git fetch -- 'contributor' 'refs/heads/fix/it'\\''s'");
    expect(run.stderr).toContain("--from 'forksha'");
    expect(run.stderr).not.toContain('--branch');
    expect(run.stderr).not.toContain('password');
    expect(run.stderr).not.toContain('secret');
  });

  it('uses the head repository URL when no configured remote names it', () => {
    const cwd = gitCheckout({}, track);
    const run = check({
      cwd,
      source: 'forge',
      forge: view({
        head_repo: { host: 'git.example.com', path: 'fork/project' },
        head_revision: 'forksha',
      }),
    });
    expect(run.stderr).toContain("git fetch -- 'https://git.example.com/fork/project.git'");
  });

  it('pins the fetched head even when setup later fetches the base', () => {
    const cwd = gitCheckout({}, track);
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'feature');
    const run = check({ cwd, source: 'forge', forge: view({ head_revision: head }) });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`--from '${head}'`);
    git(cwd, 'fetch', '--', 'upstream', 'refs/heads/feature');
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
      'null',
      'wrong',
      'message-pr',
      'message-pr-no-ambient',
      'message-pr-ambient-declaration',
      'message-pr-no-ambient-null',
    ]) {
      const matching = scenario === 'matching';
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
  : ${JSON.stringify(forgeOperation('pr.view', scenario.startsWith('message-pr-no-ambient') ? null : { pr: forgePrRecord({ head_revision: head }) }))};
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
            head,
            cursor: continuation ? head : '',
            risks: 'fixture',
            execution: {},
            seams: continuation,
            code: continuation,
            tests: false,
            errors: false,
            docs: continuation,
          };
          stubs.scope = {
            selector,
            pr:
              scenario === 'null' || scenario === 'message-pr-no-ambient-null'
                ? null
                : scenario === 'message-pr-ambient-declaration'
                  ? PR
                  : scenario === 'wrong'
                    ? { ...PR, number: 99 }
                    : target,
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
            expect(states.get('route')).toBe(continuation ? 'skipped' : 'stubbed');
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
            expect(result.trace.find(entry => entry.nodeId === 'head-check')?.reason).toContain(
              scenario === 'mismatch' ||
                scenario === 'message-pr' ||
                scenario === 'message-pr-no-ambient'
                ? 'anotherhead'
                : 'does not match'
            );
            if (override)
              expect(result.trace.find(entry => entry.nodeId === 'head-check')?.reason).toContain(
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
  for (const scenario of ['matching', 'mismatch', 'missing declaration']) {
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
          head,
          cursor: 'before-reshape',
          risks: 'fixture',
          execution: {},
          seams: false,
          code: true,
          tests: false,
          errors: false,
          docs: false,
        };
        stubs['rereview__scope'] = {
          selector: PR_URL,
          pr: scenario === 'missing declaration' ? null : PR,
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
        if (scenario === 'missing declaration') {
          expect(
            result.trace.find(entry => entry.nodeId === 'rereview__head-check')?.reason
          ).toContain('does not match the recorded pull request');
          expect(existsSync(log)).toBe(false);
        } else {
          expect(readFileSync(log, 'utf8')).toContain('pr.view');
          if (scenario === 'mismatch')
            expect(
              result.trace.find(entry => entry.nodeId === 'rereview__head-check')?.reason
            ).toContain('anotherhead');
        }
      } finally {
        for (const [key, value] of Object.entries(priorEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
});
