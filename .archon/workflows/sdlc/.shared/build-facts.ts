import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BlockedItem,
  type BuildRound,
  buildBranch,
  itemPullRequest,
} from './build.ts';
import { forgeSource, record, type PrRecord, type QualifiedPr, sameRepo } from './forge.ts';
import { artifactsDir, emit } from './io.ts';
import { POLICY_DEFAULTS } from './policy-defaults.ts';
import { viewPr } from './pr.ts';
import { runDetail } from './state.ts';
import { type WorkItem, withPlainReports } from './workitem.ts';

export function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Write the issue every agent reads; its path is fixed so the prompts name it. */
export function writeIssue(title: string, url: string, body: string): void {
  const dir = join(artifactsDir(), 'build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'issue.md'), `# ${title}\n\n${url}, now.\n\n${body}\n`);
}

/** The actual branch selected before the worker checkout is provisioned. */
interface ItemPr {
  readonly pull_request: PrRecord | null;
  readonly continues: number | null;
  readonly branch: string;
}

export const NO_ITEM_PR: ItemPr = { pull_request: null, continues: null, branch: '' };

export function resolvePr(
  subject: QualifiedPr,
  title: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  runId: string
): ItemPr {
  const ref = itemPullRequest(rounds, doc?.facts.triage, subject.repo);
  const pr = ref === null ? null : viewPr(ref, forgeSource()).pr;
  if (pr !== null && pr.state === 'open' && pr.head_repo !== null && sameRepo(pr.head_repo, subject.repo)) {
    return { pull_request: pr, continues: pr.number, branch: pr.head };
  }
  const previous = rounds.at(-1);
  if (pr === null && previous !== undefined) {
    const run = runDetail(previous.run_id);
    if (run === undefined) throw new Error(`cannot establish the branch of previous round ${previous.run_id}; inspect that run before another pickup`);
    if (run.workflow_name === 'archon-build-round') {
      const branch = record(record(run.metadata)?.inputs)?.selected_branch;
      if (typeof branch !== 'string' || branch === '') throw new Error(`previous round ${previous.run_id} records no selected branch`);
      return { pull_request: null, continues: null, branch };
    }
  }
  return { pull_request: pr, continues: null, branch: buildBranch(subject.number, title, runId) };
}

export function emitItem(
  path: 'closed' | 'route',
  subject: QualifiedPr,
  url: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  atCap: boolean,
  itemPr: ItemPr,
  blocked: readonly BlockedItem[]
): void {
  emit({
    path,
    item: subject,
    url,
    record: doc === null ? null : withPlainReports(doc),
    brief: doc?.facts.build?.brief ?? '',
    rounds,
    at_cap: atCap,
    policy_defaults: POLICY_DEFAULTS,
    ...itemPr,
    blocked,
    blocked_count: blocked.length,
  });
}
