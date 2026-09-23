/**
 * `bun run validate` is the documented pre-pull-request command, so a green run has to mean
 * the pull-request gates will pass. It stops meaning that the moment a workflow runs a check
 * of its own — which is how the workflow fixtures, the docs build and the marketplace lint
 * ended up gating pull requests while `validate` knew nothing about them (#3290).
 *
 * So: every Bun command a `pull_request`-triggered workflow runs is either `bun run validate`,
 * dependency install, or an entry in `NOT_IN_VALIDATE` with the reason it cannot join. Adding a
 * gate without deciding which of the three it is fails here.
 *
 * The other direction holds too. CI splits validate across jobs with `--only <id>` so the slow
 * checks run side by side, and every check has to land in at least one of them, on an OS where
 * it actually runs (a check that skips itself on Windows does not count as gated by a
 * Windows-only step). No check runs twice on one OS, because that is minutes of CI per round
 * spent proving nothing new.
 *
 * Two limits worth knowing. Non-Bun steps are out of scope, so the Docker image build is
 * excluded by prose (CONTRIBUTING.md) rather than by this test. And `pull_request_target`
 * workflows are excluded because they run maintainer automation against a fork's head rather
 * than checks a contributor can reproduce.
 *
 * Workflows are read with Bun's YAML parser, so comments cannot register as triggers, jobs or
 * steps. A step's `run:` body is then scanned as text because the command is the shell
 * program itself.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { VALIDATE_CHECKS } from './validate';

const WORKFLOW_DIR = resolve(import.meta.dir, '../.github/workflows');

/** Not a repository check, so it needs no justification. */
const DEPENDENCY_INSTALL = 'bun install';

/**
 * PR-gating Bun commands that deliberately stay out of `validate`, each with the environment
 * it needs that a contributor may not have. Adding an entry is the decision to leave a gate
 * unreproducible locally; CONTRIBUTING.md carries the same list in prose for contributors.
 */
const NOT_IN_VALIDATE: readonly { command: string; reason: string }[] = [
  {
    command: 'bun scripts/should-run-test-suite.ts',
    reason: 'Decides whether the suite runs at all. CI plumbing, not a repository check.',
  },
  {
    command: 'bun scripts/test-suite-outcome.ts',
    reason: "Judges the other test-suite jobs' results. CI plumbing, not a repository check.",
  },
  {
    command: 'bun run check:schema-upgrades',
    reason: 'Applies every released schema to a live PostgreSQL service.',
  },
  {
    command: 'bun run check:sqlite-vintages',
    reason:
      'Reads every release tag with `git show`, so it needs the unshallowed checkout its job takes.',
  },
  {
    command:
      'bun test packages/core/src/db/isolation-environments.live-run.postgres.integration.test.ts',
    reason: 'Exercises the Postgres dialect against a live PostgreSQL service.',
  },
  {
    command: 'bun test packages/core/src/db/resource-slots.postgres.integration.test.ts',
    reason: 'Proves the Postgres slot-release query against a live PostgreSQL service.',
  },
  {
    command: 'bun run build:docs',
    reason:
      "Astro's CLI runs under Node, not Bun, so a checkout with only Bun cannot build the docs " +
      'site; docs-build.yml runs it with a Node setup, path-filtered to the docs site.',
  },
  {
    command: 'bun packages/docs-web/scripts/lint-marketplace.ts',
    reason:
      'Spends 9 unauthenticated github.com API calls per run against a 60/hour per-IP quota, so ' +
      'seven validate runs an hour turn the gate red with HTTP 403s that say nothing about the change.',
  },
];

type Platform = 'Linux' | 'Windows' | 'macOS';

/** Hosted runner label prefix to the `runner.os` value a step condition compares against. */
const RUNNER_LABEL_PLATFORMS: readonly [prefix: string, platform: Platform][] = [
  ['ubuntu-', 'Linux'],
  ['windows-', 'Windows'],
  ['macos-', 'macOS'],
];

/** One Bun invocation inside a PR-gating step, and the OSes that step runs on. */
interface GateCommand {
  location: string;
  command: string;
  platforms: Platform[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPullRequestTrigger(content: string): boolean {
  const parsed: unknown = Bun.YAML.parse(content);
  if (!isRecord(parsed) || !('on' in parsed)) return false;

  const trigger = parsed.on;
  if (trigger === 'pull_request') return true;
  if (Array.isArray(trigger)) return trigger.includes('pull_request');
  return isRecord(trigger) && 'pull_request' in trigger;
}

/** Workflows that gate a pull request. `pull_request_target` is deliberately not one. */
function pullRequestWorkflows(): { name: string; content: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => ({
      name,
      content: readFileSync(resolve(WORKFLOW_DIR, name), 'utf8').replace(/\r\n/g, '\n'),
    }))
    .filter(({ content }) => hasPullRequestTrigger(content));
}

function platformOfLabel(label: unknown, location: string): Platform {
  const match = RUNNER_LABEL_PLATFORMS.find(
    ([prefix]) => typeof label === 'string' && label.startsWith(prefix)
  );
  if (match === undefined) {
    throw new Error(`${location}: cannot tell which OS runner label ${String(label)} is`);
  }
  return match[1];
}

/** The OSes a job runs on: a literal runner label, or the labels of a `matrix.os` axis. */
function jobPlatforms(job: Record<string, unknown>, location: string): Platform[] {
  const runsOn = job['runs-on'];
  if (typeof runsOn === 'string' && runsOn.includes('matrix.os')) {
    const matrix = isRecord(job.strategy) ? job.strategy.matrix : undefined;
    const labels = isRecord(matrix) ? matrix.os : undefined;
    if (!Array.isArray(labels)) throw new Error(`${location}: runs-on names matrix.os, none found`);
    return labels.map(label => platformOfLabel(label, location));
  }
  return [platformOfLabel(runsOn, location)];
}

/** A condition that reads which OS or matrix leg it runs on. */
const OS_REFERENCE = /\b(?:runner\.os|matrix\.)/;

/**
 * Narrows a job's OSes by a step's `if: runner.os == '<OS>'`, the one form CI uses. Any other
 * condition that reads the OS or a matrix value throws rather than being counted on every OS
 * the job runs on.
 */
function stepPlatforms(step: Record<string, unknown>, platforms: Platform[], location: string) {
  const condition = step.if;
  if (typeof condition !== 'string' || !OS_REFERENCE.test(condition)) return platforms;
  const match = /^runner\.os == '(Linux|Windows|macOS)'$/.exec(condition.trim());
  if (match === null) {
    throw new Error(`${location}: unsupported OS condition ${JSON.stringify(condition)}`);
  }
  return platforms.filter(platform => platform === match[1]);
}

/** A job-level condition that reads the OS or a matrix value is not modelled at all. */
function assertNoJobOsCondition(job: Record<string, unknown>, location: string): void {
  if (typeof job.if === 'string' && OS_REFERENCE.test(job.if)) {
    throw new Error(`${location}: unsupported job-level OS condition ${JSON.stringify(job.if)}`);
  }
}

/**
 * Bun invocations inside one step body. `bun` is matched as a command word so command
 * substitution (`x=$(bun …)`) counts, a command ends at a shell separator so `a && bun b`
 * and `bun a && bun b` each yield their own entry, and shell comment lines are dropped so
 * the prose in these workflows cannot register as a command.
 */
function bunCommands(step: string): string[] {
  return step
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .flatMap(line => [...line.matchAll(/(?:^|[\s;&|($])bun\s+[^;&|)\n]*/g)])
    .map(match => match[0].replace(/^[\s;&|($]+/, '').trim());
}

function gateCommands(): GateCommand[] {
  return pullRequestWorkflows().flatMap(({ name, content }) => {
    const parsed: unknown = Bun.YAML.parse(content);
    const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
    return Object.entries(jobs).flatMap(([jobId, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return [];
      const location = `${name}: ${jobId}`;
      assertNoJobOsCondition(job, location);
      const platforms = jobPlatforms(job, location);
      return job.steps.flatMap(step => {
        if (!isRecord(step) || typeof step.run !== 'string') return [];
        const stepOn = stepPlatforms(step, platforms, location);
        return bunCommands(step.run).map(command => ({ location, command, platforms: stepOn }));
      });
    });
  });
}

/** Check ids one `bun run validate …` invocation gates. No `--only` gates everything. */
function gatedIds(command: string): string[] {
  const only = [...command.matchAll(/--only[= ]([^\s)"']+)/g)].flatMap(match =>
    match[1].split(',').filter(id => id.length > 0)
  );
  return only.length > 0 ? only : VALIDATE_CHECKS.map(check => check.id);
}

/** Each (check, OS) pair CI runs, once per step that runs it. Windows skips are not runs. */
function checkRuns(): { id: string; platform: Platform; location: string }[] {
  const skipsOnWindows = new Set(
    VALIDATE_CHECKS.filter(check => check.skipOnWindows !== undefined).map(check => check.id)
  );
  return gateCommands()
    .filter(({ command }) => command.startsWith('bun run validate'))
    .flatMap(({ command, platforms, location }) =>
      gatedIds(command).flatMap(id =>
        platforms
          .filter(platform => platform !== 'Windows' || !skipsOnWindows.has(id))
          .map(platform => ({ id, platform, location }))
      )
    );
}

describe('validate covers the pull-request gates', () => {
  test('workflow discovery reads trigger syntax rather than arbitrary prose', () => {
    expect(hasPullRequestTrigger('on:\n  pull_request:\n')).toBe(true);
    expect(hasPullRequestTrigger('on: [push, pull_request]\n')).toBe(true);
    expect(hasPullRequestTrigger('on: pull_request\n')).toBe(true);
    expect(hasPullRequestTrigger('on: push\njobs:\n  note: pull_request\n')).toBe(false);
  });

  test('an OS condition other than runner.os == <OS> fails instead of counting on every OS', () => {
    const both: Platform[] = ['Linux', 'Windows'];
    expect(stepPlatforms({ if: "runner.os == 'Windows'" }, both, 'x')).toEqual(['Windows']);
    expect(stepPlatforms({ if: 'failure()' }, both, 'x')).toEqual(both);
    expect(() => stepPlatforms({ if: "matrix.os == 'windows-latest'" }, both, 'x')).toThrow(
      'unsupported OS condition'
    );
    expect(() => stepPlatforms({ if: "runner.os != 'Linux'" }, both, 'x')).toThrow(
      'unsupported OS condition'
    );
    expect(() => assertNoJobOsCondition({ if: "matrix.os == 'ubuntu-latest'" }, 'x')).toThrow(
      'unsupported job-level OS condition'
    );
  });

  test('every Bun command in a PR-gating workflow runs through validate or is declared', () => {
    const undeclared = gateCommands()
      .filter(
        ({ command }) =>
          !command.startsWith('bun run validate') &&
          !command.startsWith(DEPENDENCY_INSTALL) &&
          !NOT_IN_VALIDATE.some(entry => command.startsWith(entry.command))
      )
      .map(({ location, command }) => `${location}: ${command}`);

    expect(
      undeclared,
      [
        'A pull-request gate runs a command `bun run validate` does not.',
        'Add the check to VALIDATE_CHECKS in scripts/validate.ts and call it from the workflow',
        'as `bun run validate --only <id>`, or add it to NOT_IN_VALIDATE here with the reason',
        'a contributor cannot run it — and say so in CONTRIBUTING.md.',
      ].join('\n')
    ).toEqual([]);
  });

  test('every --only id names a check that exists', () => {
    const known = new Set(VALIDATE_CHECKS.map(check => check.id));
    const unknown = gateCommands()
      .filter(({ command }) => command.startsWith('bun run validate'))
      .flatMap(({ location, command }) =>
        [...command.matchAll(/--only[= ]([^\s)"']+)/g)]
          .flatMap(match => match[1].split(','))
          .filter(id => id.length > 0 && !known.has(id))
          .map(id => `${location}: --only ${id}`)
      );

    expect(unknown).toEqual([]);
  });

  test('every check validate runs is gated by CI on an OS where it runs', () => {
    const gated = new Set(checkRuns().map(({ id }) => id));
    const ungated = VALIDATE_CHECKS.map(check => check.id).filter(id => !gated.has(id));
    expect(
      ungated,
      'Add each id to a `bun run validate --only` step in a pull-request workflow.'
    ).toEqual([]);
  });

  test('no check runs twice on the same OS', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { id, platform, location } of checkRuns()) {
      const key = `${id} on ${platform}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, location);
      else duplicates.push(`${key}: ${first} and ${location}`);
    }
    expect(duplicates).toEqual([]);
  });

  test('every declared exclusion is still a command CI runs', () => {
    const commands = gateCommands().map(({ command }) => command);
    const stale = NOT_IN_VALIDATE.filter(
      entry => !commands.some(command => command.startsWith(entry.command))
    ).map(entry => entry.command);

    expect(stale).toEqual([]);
  });
});
