/**
 * File every accepted discovery as a tracker issue, once.
 *
 * Review certifies the work it proved but this change does not do (unrelated
 * defects, a fix an operator-stated boundary stopped, a note the change leaves
 * unfixed) as typed discovery records on its verdict. A record nobody files is lost
 * when the run ends, so delivery files one issue per record, linking back to the run
 * and the pull request. The final verdict's records win: the correction loop's when
 * it ran, otherwise the first review's.
 *
 * Two guards against duplicates, with different owners:
 * - Across runs, a defect another run already filed is a judgment: the preceding
 *   agent searched the open issues and declared matches. A match is reused only when
 *   the forge confirms an open issue in this repository; anything else files the
 *   record as new, with a note. A missed match files a duplicate; it never blocks.
 * - Within a run, a resume must not file the same record twice. Each issue carries a
 *   marker keyed by the repository, title and claim, and an open issue with this
 *   record's marker is reused. The marker is idempotency for one record, not a
 *   cross-run dedup: two runs word one defect differently.
 *
 * gh is the transport: the forge contract has no issue operations yet. Each created
 * issue is read back before the node succeeds.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_INITIAL / INPUTS_FINAL: the first review's and the correction loop's
 *   certified discoveries; FINAL is `null` when no correction ran.
 * - INPUTS_MATCHES: `[{index, duplicate_of}]` from the matching agent.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrRecord } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import type { Discovery } from '../../.shared/report.ts';

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function body(record: Discovery, marker: string, prUrl: string): string {
  return [
    marker,
    record.claim,
    '',
    '## Evidence',
    '',
    record.evidence.map(item => `- ${item}`).join('\n'),
    '',
    `Found while delivering ${prUrl} (Archon run \`${process.env.WORKFLOW_ID ?? 'unknown'}\`, ` +
      `recorded by ${record.source_nodes.join(', ')}). The run filed it instead of fixing it in that change.`,
  ].join('\n');
}

/**
 * An open issue in `repo` at `url`, as the forge reports it. Matching is best effort
 * by decision: an issue that cannot be confirmed open, for whatever reason, is not
 * reused, and the record is filed as new rather than blocking the run.
 */
function openIssue(repo: string, url: string): boolean {
  try {
    const view = JSON.parse(gh('issue', 'view', url, '--repo', repo, '--json', 'state,url')) as {
      state: string;
      url: string;
    };
    return view.state === 'OPEN';
  } catch {
    return false;
  }
}

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const repo = `${pr.repo.host}/${pr.repo.path}`;
  const final = JSON.parse(text(process.env.INPUTS_FINAL)) as Discovery[] | null;
  const records = final ?? (JSON.parse(text(process.env.INPUTS_INITIAL)) as Discovery[]);
  const matches = JSON.parse(text(process.env.INPUTS_MATCHES)) as {
    index: number;
    duplicate_of: string;
  }[];

  const filed: { title: string; issue: string }[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'archon-discovery-'));
  try {
    for (const [index, record] of records.entries()) {
      const match = matches.find(candidate => candidate.index === index)?.duplicate_of;
      if (match !== undefined) {
        if (openIssue(repo, match)) {
          filed.push({ title: record.title, issue: match });
          continue;
        }
        note(`file-discoveries: ${match} is not an open issue in ${repo}; filing "${record.title}" as new.`);
      }
      const key = createHash('sha256')
        .update(`${repo}\n${record.title}\n${record.claim}`)
        .digest('hex');
      const marker = `<!-- archon-discovery:${key} -->`;
      const existing = JSON.parse(
        gh('issue', 'list', '--repo', repo, '--state', 'open', '--search', `"archon-discovery:${key}" in:body`, '--json', 'url')
      ) as { url: string }[];
      let url = existing[0]?.url;
      if (url === undefined) {
        const bodyPath = join(scratch, `body-${String(index)}.md`);
        writeFileSync(bodyPath, body(record, marker, pr.url));
        url = gh('issue', 'create', '--repo', repo, '--title', record.title, '--body-file', bodyPath);
        const readBack = JSON.parse(gh('issue', 'view', url, '--json', 'title')) as { title: string };
        if (readBack.title !== record.title) throw new Error(`issue read-back disagrees for ${url}`);
      }
      filed.push({ title: record.title, issue: url });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  emit({ records: filed });
} catch (error) {
  refuse(`file-discoveries: ${error instanceof Error ? error.message : String(error)}`);
}
