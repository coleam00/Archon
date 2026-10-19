/**
 * Enroll maintainers' own open pull requests in the merge queue.
 *
 * A maintainer whose maintainer-list entry sets `merge_queue: "own-prs"` gets each of
 * their open, non-draft pull requests a work item of its own, so a pull request they
 * opened by hand merges under the policy like one the build queue delivered. A pull
 * request a work item already names, through a build round or an earlier enrollment,
 * is left alone.
 */

import { prFromUrl, itemPr } from './merge.ts';
import type { QualifiedPr } from './forge.ts';
import { stateDocuments, stateGet, statePut } from './state.ts';
import { newWorkItem, parseWorkItem, type WorkItem, workItemName } from './workitem.ts';

interface OpenPr {
  readonly number: number;
  readonly url: string;
  readonly isDraft: boolean;
}

function openPrsBy(repo: QualifiedPr['repo'], author: string): OpenPr[] {
  const result = Bun.spawnSync(
    ['gh', 'pr', 'list', '--repo', `${repo.host}/${repo.path}`, '--state', 'open', '--author', author, '--json', 'number,url,isDraft', '--limit', '100'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString()) as OpenPr[];
}

/** The pull request numbers some work item already names. */
function namedPrs(): Set<number> {
  const named = new Set<number>();
  for (const stored of stateDocuments('work/')) {
    if (stored.value === null) continue;
    named.add(Number(stored.name.slice('work/'.length)));
    const pr = itemPr(parseWorkItem(stored.value));
    if (pr !== null) named.add(pr.number);
  }
  return named;
}

/** An enrolled own pull request that no build round has taken over since. */
export function isOwnPr(doc: WorkItem): boolean {
  return doc.facts.own_pr !== undefined && doc.facts.build === undefined;
}

/** Create a work item for each own pull request no work item names; returns their numbers. */
export function enrollOwnPrs(repo: QualifiedPr['repo'], authors: ReadonlySet<string>, at: string): number[] {
  if (authors.size === 0) return [];
  const named = namedPrs();
  const enrolled: number[] = [];
  for (const author of authors) {
    for (const pr of openPrsBy(repo, author)) {
      if (pr.isDraft || named.has(pr.number)) continue;
      const subject = prFromUrl(pr.url);
      const name = workItemName(subject.number);
      const stored = stateGet(name);
      if (stored.value !== null) continue;
      const doc = { ...newWorkItem(subject, at), facts: { own_pr: { url: pr.url, at } } };
      if (statePut(name, doc, stored.revision) === 'ok') enrolled.push(subject.number);
    }
  }
  return enrolled;
}
