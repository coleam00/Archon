import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The release workflow's argument parsing, run the way the engine runs a `script:` node:
 * a Bun subprocess with the body on `-e` and the run message in the environment.
 *
 * The workflow's release tail is gated on this node's output, so a body that stops
 * reading the message turns a `--dry-run` request into a real release, and nothing else
 * in the repository reports it: the corpus lint reads the YAML but never runs a body.
 */
const REPO = join(import.meta.dir, '..');
const WORKFLOW = join(REPO, '.archon', 'workflows', 'experimental', 'archon-release.yaml');

/** The `script:` body of the workflow's `parse-args` node. */
function parseArgsBody(): string {
  const workflow: unknown = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  if (typeof workflow !== 'object' || workflow === null) {
    throw new Error('archon-release.yaml did not parse into an object');
  }
  const nodes: unknown = (workflow as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) throw new Error('archon-release.yaml has no nodes list');
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const candidate = node as { id?: unknown; script?: unknown };
    if (candidate.id === 'parse-args' && typeof candidate.script === 'string') {
      return candidate.script;
    }
  }
  throw new Error('archon-release.yaml has no parse-args script node');
}

const BODY = parseArgsBody();

/**
 * Runs the node's body with the given run message, the way the engine runs it: the
 * message arrives in the environment, because a `script:` body never substitutes it
 * into the source. `undefined` leaves the variable unset.
 */
function runParseArgs(message: string | undefined): unknown {
  const env: Record<string, string | undefined> = { ...process.env };
  if (message === undefined) delete env.ARGUMENTS;
  else env.ARGUMENTS = message;
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', BODY], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`parse-args exited ${String(result.exitCode)}: ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString().trim());
}

describe('archon-release argument parsing', () => {
  test.each([
    ['minor --dry-run', { bump: 'minor', dryRun: 'true' }],
    ['major', { bump: 'major', dryRun: 'false' }],
    ['patch', { bump: 'patch', dryRun: 'false' }],
    ['', { bump: 'patch', dryRun: 'false' }],
  ])('reads %p from the run message', (message: string, expected: unknown) => {
    expect(runParseArgs(message)).toEqual(expected);
  });

  test('defaults to a patch release when the run message is unset', () => {
    expect(runParseArgs(undefined)).toEqual({ bump: 'patch', dryRun: 'false' });
  });
});
