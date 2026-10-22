/**
 * The project's maintainer list: `.archon/sdlc/policy/maintainers.json` on the default
 * branch. Each entry is a forge login, or an object naming one with opt-ins:
 *
 *   ["alice", { "login": "bob", "merge_queue": "own-prs" }]
 *
 * Every listed login is a maintainer, whose labels and review comments the queues trust.
 * `merge_queue: "own-prs"` also enrolls that maintainer's own open pull requests in the
 * merge queue, so a pull request they open by hand merges under the policy.
 */

import { record, type QualifiedPr } from './forge.ts';
import { gitOrThrow } from './git.ts';
import { fetchDefaultBranch } from './remote.ts';

export const MAINTAINERS_PATH = '.archon/sdlc/policy/maintainers.json';

export interface MaintainerList {
  /** Every listed login, lower-cased. */
  readonly logins: ReadonlySet<string>;
  /** The logins whose own pull requests the merge queue enrolls. */
  readonly ownPrs: ReadonlySet<string>;
}

const INVALID = `${MAINTAINERS_PATH} must be a JSON array of forge logins or { "login", "merge_queue"? } entries`;

function entry(value: unknown): { login: string; ownPrs: boolean } {
  if (typeof value === 'string' && value.trim() !== '') return { login: value.trim().toLowerCase(), ownPrs: false };
  const object = record(value);
  const login = object?.login;
  const mergeQueue = object?.merge_queue;
  if (typeof login !== 'string' || login.trim() === '' || !(mergeQueue === undefined || mergeQueue === 'own-prs')) {
    throw new Error(INVALID);
  }
  return { login: login.trim().toLowerCase(), ownPrs: mergeQueue === 'own-prs' };
}

/** The maintainer list's text; anything but the documented shape refuses. */
export function parseMaintainerList(text: string): MaintainerList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${MAINTAINERS_PATH} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(INVALID);
  const entries = parsed.map(entry);
  return {
    logins: new Set(entries.map(item => item.login)),
    ownPrs: new Set(entries.filter(item => item.ownPrs).map(item => item.login)),
  };
}

/** The listed logins, lower-cased. */
export function parseMaintainers(text: string): Set<string> {
  return new Set(parseMaintainerList(text).logins);
}

/**
 * The maintainer list at the head of the repository's default branch, read with git
 * so it works on either forge source and whatever branch the checkout sits on. No
 * file means nobody: every author is outside.
 */
export function readMaintainerList(repo: QualifiedPr['repo']): MaintainerList {
  const { sha } = fetchDefaultBranch(repo);
  if (gitOrThrow('ls-tree', '--name-only', sha, '--', MAINTAINERS_PATH) === '') return { logins: new Set(), ownPrs: new Set() };
  return parseMaintainerList(gitOrThrow('show', `${sha}:${MAINTAINERS_PATH}`));
}

export function readMaintainers(repo: QualifiedPr['repo']): Set<string> {
  return new Set(readMaintainerList(repo).logins);
}
