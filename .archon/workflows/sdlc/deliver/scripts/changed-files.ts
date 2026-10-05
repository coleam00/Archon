/**
 * The files this pull request changes, read from git.
 *
 * The CI cause decision tests a failure's location against this list, so it comes
 * from the checkout, not from an agent. The base is fetched first, from the remote
 * that holds the pull request's repository (never a remote picked by name): a stale
 * or forked base would count commits the base already has as this branch's changes.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { parsePrRecord } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';
import { remoteRefFor } from '../../.shared/remote.ts';

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)) as unknown);
  const base = remoteRefFor(pr.repo, pr.base);
  const files = git('diff', '--name-only', `${base}...HEAD`)
    .split('\n')
    .filter(line => line !== '');
  emit({ files });
} catch (error) {
  refuse(`changed-files: ${error instanceof Error ? error.message : String(error)}`);
}
