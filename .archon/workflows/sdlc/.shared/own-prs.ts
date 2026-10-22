/**
 * Enroll maintainers' own open pull requests in the merge queue.
 *
 * A maintainer whose maintainer-list entry sets `merge_queue: "own-prs"` gets each of
 * their open, non-draft pull requests a work item of its own, so a pull request they
 * opened by hand merges under the policy like one the build queue delivered. A pull
 * request a work item already names, through a build round or an earlier enrollment,
 * is left alone. A build round records its pull request when the round ends, so one
 * listed while the round still runs can enroll; that short window is an accepted gap,
 * and enrollment after the round finds the pull request recorded.
 */

import { forgeSource, record, samePr, type QualifiedPr } from './forge.ts';
import { note } from './io.ts';
import { prFromUrl } from './merge.ts';
import { stateDocuments, stateGet, statePut } from './state.ts';
import { newWorkItem, read, type WorkItem, workItemName } from './workitem.ts';

/** The fields `gh pr list --json` selects, and the type each row carries for them. */
const OPEN_PR_FIELDS = { number: 'number', url: 'string', isDraft: 'boolean' } as const;
type OpenPr = {
  readonly [Field in keyof typeof OPEN_PR_FIELDS]: { number: number; string: string; boolean: boolean }[(typeof OPEN_PR_FIELDS)[Field]];
};

function openPrsBy(repo: QualifiedPr['repo'], author: string): OpenPr[] {
  const fields = Object.keys(OPEN_PR_FIELDS) as (keyof typeof OPEN_PR_FIELDS)[];
  const result = Bun.spawnSync(
    ['gh', 'pr', 'list', '--repo', `${repo.host}/${repo.path}`, '--state', 'open', '--author', author, '--json', fields.join(','), '--limit', '100'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${result.stderr.toString().trim()}`);
  const rows: unknown = JSON.parse(result.stdout.toString());
  if (!Array.isArray(rows)) throw new Error('gh pr list did not report a list');
  return rows.map(row => {
    const fieldsOf = record(row);
    const missing = fields.filter(field => typeof fieldsOf?.[field] !== OPEN_PR_FIELDS[field]);
    if (missing.length > 0) throw new Error(`gh pr list reported a pull request without ${missing.join(', ')}`);
    return fieldsOf as OpenPr;
  });
}

/**
 * The pull requests some work item already names: its subject, its own-PR URL, and the
 * PR every one of its build rounds recorded. Not only the latest round's, as `itemPr`
 * picks for the merge path: a PR an earlier round abandoned is build history, not a
 * maintainer's own PR. A malformed item or URL is noted and skipped, as the pickup
 * skips it.
 */
function namedPrs(): QualifiedPr[] {
  const named: QualifiedPr[] = [];
  for (const { name, doc } of stateDocuments('work/').flatMap(stored => read(stored.name, stored) ?? [])) {
    named.push(doc.subject);
    const urls = [...(doc.facts.build?.rounds ?? []).map(round => round.pr_url), doc.facts.own_pr?.url ?? ''];
    for (const url of urls.filter(recorded => recorded !== '')) {
      try {
        named.push(prFromUrl(url));
      } catch (error) {
        note(`own-PR enrollment skips ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
  if (forgeSource() === 'forge') {
    throw new Error(
      "own-PR enrollment lists a maintainer's open pull requests, which the forge contract cannot read; on ARCHON_SDLC_FORGE=forge no own pull request is enrolled"
    );
  }
  const named = namedPrs();
  const enrolled: number[] = [];
  for (const author of authors) {
    for (const pr of openPrsBy(repo, author).filter(listed => !listed.isDraft)) {
      const subject = prFromUrl(pr.url);
      if (named.some(claimed => samePr(claimed, subject))) continue;
      const name = workItemName(subject.number);
      const stored = stateGet(name);
      if (stored.value !== null) continue;
      const doc = { ...newWorkItem(subject, at), facts: { own_pr: { url: pr.url, at } } };
      if (statePut(name, doc, stored.revision) === 'ok') enrolled.push(subject.number);
    }
  }
  return enrolled;
}
