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
 * Two limits worth knowing. Non-Bun steps are out of scope, so the Docker image build is
 * excluded by prose (CONTRIBUTING.md) rather than by this test. And `pull_request_target`
 * workflows are excluded because they run maintainer automation against a fork's head rather
 * than checks a contributor can reproduce.
 *
 * Text scanning, not YAML parsing: the repository has no YAML dependency at the root, and
 * `scripts/bun-version-consistency.test.ts` and `scripts/publish-triggers.test.ts` already read
 * these files the same way.
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
    command: 'bun packages/docs-web/scripts/lint-marketplace.ts',
    reason:
      'Spends 9 unauthenticated github.com API calls per run against a 60/hour per-IP quota, so ' +
      'six validate runs an hour turn the gate red with HTTP 403s that say nothing about the change.',
  },
];

interface WorkflowCommand {
  workflow: string;
  command: string;
}

/** Workflows that gate a pull request. `pull_request_target` is deliberately not one. */
function pullRequestWorkflows(): { name: string; content: string }[] {
  return (
    readdirSync(WORKFLOW_DIR)
      .filter(name => name.endsWith('.yml'))
      .map(name => ({
        name,
        content: readFileSync(resolve(WORKFLOW_DIR, name), 'utf8').replace(/\r\n/g, '\n'),
      }))
      // Matches the block form these workflows use and an inline `pull_request: {…}` alike, so a
      // future workflow cannot slip past this test by writing its trigger in flow style.
      .filter(({ content }) => /^ {2}pull_request(?![_A-Za-z])/m.test(content))
  );
}

/** Every `run:` step body, inline or block scalar. */
function runSteps(workflow: string): string[] {
  const lines = workflow.split('\n');
  const steps: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(- )?run:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;

    const keyIndent = match[1].length + (match[2] === undefined ? 0 : 2);
    const inline = match[3].trim();
    if (!/^[|>][+-]?\d*$/.test(inline)) {
      steps.push(inline.replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }

    const body: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const indent = next.length - next.trimStart().length;
      if (next.trim() !== '' && indent <= keyIndent) break;
      body.push(next);
      index++;
    }
    steps.push(body.join('\n'));
  }

  return steps;
}

/**
 * Bun invocations inside one step body. `bun` is matched as a command word so command
 * substitution (`x=$(bun …)`) counts, and shell comment lines are dropped so the prose in
 * these workflows cannot register as a command.
 */
function bunCommands(step: string): string[] {
  return step
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .flatMap(line => [...line.matchAll(/(?:^|[\s;&|($])bun\s+(?:[^\n]*)/g)])
    .map(match => match[0].replace(/^[\s;&|($]+/, '').trim());
}

function workflowBunCommands(): WorkflowCommand[] {
  return pullRequestWorkflows().flatMap(({ name, content }) =>
    runSteps(content)
      .flatMap(bunCommands)
      .map(command => ({ workflow: name, command }))
  );
}

/** Check ids one `bun run validate …` invocation gates. No `--only` gates everything. */
function gatedIds(command: string): string[] {
  const only = [...command.matchAll(/--only[= ]([^\s)"']+)/g)].flatMap(match =>
    match[1].split(',').filter(id => id.length > 0)
  );
  return only.length > 0 ? only : VALIDATE_CHECKS.map(check => check.id);
}

describe('validate covers the pull-request gates', () => {
  test('every Bun command in a PR-gating workflow runs through validate or is declared', () => {
    const undeclared = workflowBunCommands()
      .filter(
        ({ command }) =>
          !command.startsWith('bun run validate') &&
          !command.startsWith(DEPENDENCY_INSTALL) &&
          !NOT_IN_VALIDATE.some(entry => command.startsWith(entry.command))
      )
      .map(({ workflow, command }) => `${workflow}: ${command}`);

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
    const unknown = workflowBunCommands()
      .filter(({ command }) => command.startsWith('bun run validate'))
      .flatMap(({ workflow, command }) =>
        [...command.matchAll(/--only[= ]([^\s)"']+)/g)]
          .flatMap(match => match[1].split(','))
          .filter(id => id.length > 0 && !known.has(id))
          .map(id => `${workflow}: --only ${id}`)
      );

    expect(unknown).toEqual([]);
  });

  test('every check validate runs is gated by CI', () => {
    const gated = new Set(
      workflowBunCommands()
        .filter(({ command }) => command.startsWith('bun run validate'))
        .flatMap(({ command }) => gatedIds(command))
    );

    const ungated = VALIDATE_CHECKS.map(check => check.id).filter(id => !gated.has(id));
    expect(ungated).toEqual([]);
  });

  test('every declared exclusion is still a command CI runs', () => {
    const commands = workflowBunCommands().map(({ command }) => command);
    const stale = NOT_IN_VALIDATE.filter(
      entry => !commands.some(command => command.startsWith(entry.command))
    ).map(entry => entry.command);

    expect(stale).toEqual([]);
  });
});
