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
 *   agent searched the open issues and declared matches by issue number. A match is
 *   reused only when the forge confirms an open issue at that number in this
 *   repository; anything else files the record as new, with a note. A missed match
 *   files a duplicate; it never blocks.
 * - Within a run, a resume must not file the same record twice. Each filed issue is
 *   recorded in the run's artifacts, keyed by the repository, title and claim, the
 *   moment it is created, and a resume reuses it. On the gh source, only a process
 *   killed between the create and that write can file one twice; the forge source
 *   also carries a body marker scoped to this pull request, by which the plugin
 *   recovers an issue it already created. A recovered issue that is closed refuses.
 *
 * Reads and writes go through the source the run selected. Each created issue is
 * read back before the node succeeds.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_INITIAL / INPUTS_FINAL: the first review's and the correction loop's
 *   certified discoveries; FINAL is `null` when no correction ran.
 * - INPUTS_MATCHES: `[{index, issue}]` from the matching agent.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgeSource,
  invokeForge,
  parseCreatedWorkItem,
  parsePrRecord,
  record as asRecord,
  type ForgeSource,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { artifactsDir, emit, note, refuse, text } from '../../.shared/io.ts';
import type { Discovery } from '../../.shared/report.ts';

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function body(record: Discovery, prUrl: string): string {
  return [
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
 * The URL of open issue `number` in `repo`, as the forge reports it. `gh issue view`
 * also resolves a pull request, so the URL must be this repository's issue URL.
 * Matching is best effort by decision: an issue that cannot be confirmed, for
 * whatever reason, is not reused, and the record is filed as new rather than
 * blocking the run.
 */
function openIssue(source: ForgeSource, target: QualifiedPr['repo'], number: number): string | undefined {
  const repo = `${target.host}/${target.path}`;
  try {
    if (source === 'forge') {
      const view = asRecord(invokeForge('workitem.view', { ref: { repo: target, number } }));
      return view?.kind === 'issue' && view.state === 'open' && typeof view.url === 'string'
        ? view.url
        : undefined;
    }
    const view = JSON.parse(gh('issue', 'view', String(number), '--repo', repo, '--json', 'state,url')) as {
      state: string;
      url: string;
    };
    return view.state === 'OPEN' && view.url === `https://${repo}/issues/${String(number)}` ? view.url : undefined;
  } catch {
    return undefined;
  }
}

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const source = forgeSource();
  const repo = `${pr.repo.host}/${pr.repo.path}`;
  const final = JSON.parse(text(process.env.INPUTS_FINAL)) as Discovery[] | null;
  const records = final ?? (JSON.parse(text(process.env.INPUTS_INITIAL)) as Discovery[]);
  const matches = JSON.parse(text(process.env.INPUTS_MATCHES)) as { index: number; issue: number }[];
  const ledgerPath = join(artifactsDir(), 'discoveries-filed.json');
  const ledger = (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}) as Record<
    string,
    string
  >;

  const filed: { title: string; issue: string }[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'archon-discovery-'));
  try {
    for (const [index, record] of records.entries()) {
      const match = matches.find(candidate => candidate.index === index)?.issue;
      if (match !== undefined) {
        const url = openIssue(source, pr.repo, match);
        if (url !== undefined) {
          filed.push({ title: record.title, issue: url });
          continue;
        }
        note(`file-discoveries: #${String(match)} is not an open issue in ${repo}; filing "${record.title}" as new.`);
      }
      const key = createHash('sha256').update(`${repo}\n${record.title}\n${record.claim}`).digest('hex');
      let url = ledger[key];
      if (url === undefined && source === 'forge') {
        // The plugin creates, recovers a prior create by the marker, and reads back.
        // The marker is scoped to this pull request: another delivery that finds the
        // same defect files its own issue rather than recovering one a maintainer
        // may have settled for a different change.
        const scope = createHash('sha256').update(`${pr.url}\n${key}`).digest('hex');
        const marker = `<!-- archon-discovery:${scope} -->`;
        url = parseCreatedWorkItem(
          invokeForge('workitem.create', {
            repo: pr.repo,
            title: record.title,
            marker,
            body: `${marker}\n${body(record, pr.url)}`,
          }),
          pr.repo
        );
        ledger[key] = url;
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
      } else if (url === undefined) {
        const bodyPath = join(scratch, `body-${String(index)}.md`);
        writeFileSync(bodyPath, body(record, pr.url));
        url = gh('issue', 'create', '--repo', repo, '--title', record.title, '--body-file', bodyPath);
        ledger[key] = url;
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
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
