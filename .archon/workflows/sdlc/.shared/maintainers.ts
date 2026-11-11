/**
 * The project's maintainer list: `.archon/sdlc/policy/maintainers.json` on the default
 * branch, a JSON array of forge logins:
 *
 *   ["alice", "bob"]
 *
 * Every listed login is a maintainer, whose labels and review comments the queues trust.
 */

import { type QualifiedPr } from './identity.ts';
import { gitOrThrow } from './git.ts';
import { fetchDefaultBranch } from './remote.ts';

export const MAINTAINERS_PATH = '.archon/sdlc/policy/maintainers.json';

const INVALID = `${MAINTAINERS_PATH} must be a JSON array of forge logins`;

/** The listed logins, lower-cased; anything but the documented shape refuses. */
export function parseMaintainers(text: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${MAINTAINERS_PATH} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(INVALID);
  return new Set(
    parsed.map(value => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(INVALID);
      return value.trim().toLowerCase();
    })
  );
}

/**
 * The maintainer list at the head of the repository's default branch, read with git
 * so it works on any forge and whatever branch the checkout sits on. No
 * file means nobody: every author is outside.
 */
export function readMaintainers(repo: QualifiedPr['repo']): Set<string> {
  const { sha } = fetchDefaultBranch(repo);
  if (gitOrThrow('ls-tree', '--name-only', sha, '--', MAINTAINERS_PATH) === '') return new Set();
  return parseMaintainers(gitOrThrow('show', `${sha}:${MAINTAINERS_PATH}`));
}
