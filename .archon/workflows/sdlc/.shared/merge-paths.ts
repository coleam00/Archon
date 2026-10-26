/**
 * Path facts for the merge policy: which of a pull request's changed paths fall in a
 * category the policy names, such as credentials.
 *
 * The categories are globs: the pack's defaults below, then the project's
 * `.archon/sdlc/policy/merge-paths.yaml` on its default branch, whose globs add to
 * the defaults'. Code matches paths; the sweep still judges
 * clear or unclear from `merge.md`. A category says where the policy applies, not the
 * class, so the same kind of change is looked at the same way on every sweep.
 */

import { randomUUID } from 'node:crypto';
import type { QualifiedPr } from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import type { PrFacts } from './merge.ts';
import { fetchDefaultBranch, remoteFor } from './remote.ts';

export const PROJECT_MERGE_PATHS = '.archon/sdlc/policy/merge-paths.yaml';

/** Each category's globs, matched against repository-relative paths. */
export type PathCategories = ReadonlyMap<string, readonly string[]>;

/**
 * The default policy's path-shaped unclear cases, in globs any repository can use. The
 * rest of its unclear list (size, partial work, direction) is no property of a path.
 */
export const DEFAULT_PATH_CATEGORIES: PathCategories = new Map([
  ['credentials', ['**/*credential*', '**/*oauth*', '**/*secret*', '**/auth/**']],
  ['persisted-format', ['**/migrations/**', '**/*migration*', '**/*.sql']],
]);

/** One category the pull request touches, with the changed paths that put it there. */
export interface SensitivePaths {
  readonly category: string;
  readonly paths: readonly string[];
}

/** What the sweep is given about a pull request's paths, or why it could not be read. */
export type PathFacts =
  | { readonly changed: number; readonly sensitive: readonly SensitivePaths[] }
  | { readonly error: string };

/** Whether `value` is the path facts `pathFacts` produces, for a consumer to refuse anything else. */
export function isPathFacts(value: unknown): value is PathFacts {
  if (typeof value !== 'object' || value === null) return false;
  const facts = value as Record<string, unknown>;
  if (typeof facts.error === 'string') return true;
  return (
    typeof facts.changed === 'number' &&
    Array.isArray(facts.sensitive) &&
    facts.sensitive.every(entry => {
      const found = entry as Record<string, unknown> | null;
      return typeof found?.category === 'string' && Array.isArray(found.paths) && found.paths.every(path => typeof path === 'string');
    })
  );
}

/** A `category: [glob, ...]` document; anything else refuses, naming the file. */
export function parsePathCategories(name: string, text: string): Map<string, string[]> {
  const parsed: unknown = Bun.YAML.parse(text);
  const invalid = new Error(`${name} must map each category name to a list of path globs`);
  if (parsed === null || parsed === undefined) return new Map();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid;
  const categories = new Map<string, string[]>();
  for (const [category, globs] of Object.entries(parsed)) {
    if (!Array.isArray(globs) || !globs.every(glob => typeof glob === 'string' && glob.trim() !== '')) throw invalid;
    categories.set(category, globs);
  }
  return categories;
}

/** The project's globs added to the default's, category by category. */
export function mergeCategories(defaults: PathCategories, project: PathCategories): Map<string, string[]> {
  const merged = new Map([...defaults].map(([category, globs]) => [category, [...globs]]));
  for (const [category, globs] of project) merged.set(category, [...(merged.get(category) ?? []), ...globs]);
  return merged;
}

/**
 * The default categories plus the project's, read from the head of its default branch
 * as the maintainer list is, so a pull request cannot reclassify its own paths.
 */
export function readPathCategories(repo: QualifiedPr['repo']): Map<string, string[]> {
  const { sha } = fetchDefaultBranch(repo);
  if (gitOrThrow('ls-tree', '--name-only', sha, '--', PROJECT_MERGE_PATHS) === '') return mergeCategories(DEFAULT_PATH_CATEGORIES, new Map());
  const project = parsePathCategories(PROJECT_MERGE_PATHS, gitOrThrow('show', `${sha}:${PROJECT_MERGE_PATHS}`));
  return mergeCategories(DEFAULT_PATH_CATEGORIES, project);
}

/**
 * The categories `paths` fall in, each with its matching paths; a category none match is
 * left out. Matching ignores case, so `AgentCredentialCard.tsx` is a credentials path.
 */
export function sensitivePaths(paths: readonly string[], categories: PathCategories): SensitivePaths[] {
  const found: SensitivePaths[] = [];
  for (const [category, globs] of categories) {
    const matchers = globs.map(glob => new Bun.Glob(glob.toLowerCase()));
    const matched = paths.filter(path => matchers.some(matcher => matcher.match(path.toLowerCase())));
    if (matched.length > 0) found.push({ category, paths: matched });
  }
  return found;
}

/**
 * The paths the pull request changes against its merge base with the default branch,
 * read at the head the facts saw. Renames count as both paths, so moving a file out of
 * a category still touches it. Fetches into unique refs: tracking refs are shared by
 * every worktree, and another fetch may hold their lock.
 */
export function changedPaths(facts: PrFacts): string[] {
  const remote = remoteFor(facts.pr.repo);
  const id = randomUUID();
  const head = `refs/archon/fetch/${id}-head`;
  const base = `refs/archon/fetch/${id}-base`;
  try {
    gitOrThrow(
      'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', remote,
      `refs/pull/${String(facts.pr.number)}/head:${head}`, `refs/heads/${facts.default_branch}:${base}`,
    );
    const fetched = gitOrThrow('rev-parse', '--verify', head);
    if (fetched !== facts.head_revision) throw new Error(`its head moved to ${fetched} after the facts read ${facts.head_revision}`);
    // NUL-delimited and untrimmed: git quotes a name with non-ASCII or control
    // characters in its line output, and that quoted form would match no glob.
    const diff = Bun.spawnSync(['git', 'diff', '--name-only', '-z', '--no-renames', `${base}...${head}`], { stdout: 'pipe', stderr: 'pipe' });
    if (diff.exitCode !== 0) throw new Error(`git diff ${base}...${head} failed: ${diff.stderr.toString().trim()}`);
    return diff.stdout.toString().split('\0').filter(path => path !== '');
  } finally {
    git('update-ref', '-d', head);
    git('update-ref', '-d', base);
  }
}

/** The path facts for one pull request; a failed read is the fact, so the sweep can say why it waits. */
export function pathFacts(facts: PrFacts, categories: PathCategories): PathFacts {
  try {
    const paths = changedPaths(facts);
    return { changed: paths.length, sensitive: sensitivePaths(paths, categories) };
  } catch (error) {
    return { error: `its changed paths could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
