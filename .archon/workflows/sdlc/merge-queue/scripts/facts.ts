/**
 * Read what one merge run decides from: the issue's work item, its pull request and the
 * run's base branch (`readBase`).
 *
 * The run is on the issue's item, where the engine admits one merge run at a time, so it
 * takes no claim. It refuses an item that is not the merge stage's (`mergeAccepts`), which
 * includes one the build queue would accept for another round. A parked item is accepted:
 * only an operator's own start reaches it.
 *
 * `path` says what follows. `settle`: there is nothing to judge, because the pull
 * request is already merged or closed, the item names none, or a maintainer answered the
 * stage's ask with a return or a park. `wait`: a check woke the run and what it waited
 * for is still not there (the head's checks still pending at the commit the wait
 * named), so the item waits again without the agent. `judge`:
 * the agent decides, on a snapshot of the pull request's gate facts.
 *
 * A read that fails refuses the run. The backstop leaves an item whose newest run failed
 * to the operator, who resumes or abandons that run.
 *
 * Bound inputs: INPUTS_WAITED, the wait a check met (a wake binding's `{ wait: true }`);
 * INPUTS_DECISIONS, the settled answers to the stage's ask, and INPUTS_ASKED, the result
 * of the run that asked (an asks-settled binding's `{ answers: true }` and
 * `{ result: "" }`); the pack settings INPUTS_CI, INPUTS_MERGE_LANE and
 * INPUTS_PROTECTED_PATHS. Each binding input is empty when another start made the run.
 */

import { emit, input, item as runItem, refuse } from 'archon:script';
import { latestValidation } from '../../.shared/build.ts';
import { sameRepo } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import {
  ASK_OPTIONS,
  type CiMode,
  issueOfItem,
  itemPr,
  listSetting,
  type MergeAnswer,
  type MergeStart,
  mergeAccepts,
  parseCiMode,
  parseLane,
  type PrFacts,
  protectedChanges,
  readBase,
  readPr,
} from '../../.shared/merge.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import { readWorkItem, type WorkItem } from '../../.shared/workitem.ts';

/** One settled ask, as an asks-settled binding's `{ answers: true }` passes it. */
interface SettledAsk {
  readonly closedAs: 'answered' | 'withdrawn';
  readonly answer: { readonly text: string } | null;
  readonly option: { readonly id: string } | null;
  readonly at: string;
}

/**
 * A maintainer's answer to the stage's ask: the option chosen, by its id. The pack binds
 * only the three options, so a start with any other answer is refused, never guessed
 * from the answer's words.
 */
function answer(): MergeAnswer | null {
  const settled = (nullableJson(input('decisions')) ?? []) as SettledAsk[];
  const asked = nullableJson(input('asked')) as { readonly head?: string; readonly brief?: string } | null;
  const answered = settled.find(entry => entry.closedAs === 'answered');
  if (answered === undefined || asked === null) return null;
  const chosen = ASK_OPTIONS.find(option => option.id === answered.option?.id);
  if (chosen === undefined) throw new Error(`the answer chose "${answered.option?.id ?? 'no option'}", which is none of ${ASK_OPTIONS.map(option => option.id).join(', ')}`);
  return { effect: chosen.id, text: answered.answer?.text.trim() ?? '', at: answered.at, head: asked.head ?? '', brief: asked.brief ?? '' };
}

/** Whether what the met wait was about still reads as it did when the item began to wait. */
function stillWaits(facts: PrFacts, ci: CiMode): boolean {
  const waited = nullableJson(input('waited')) as { readonly event?: string; readonly about?: string } | null;
  return waited?.event === 'checks' && ci === 'forge' && waited.about === facts.head_revision && facts.checks.state === 'pending';
}

/** The work item of the issue whose item the run is on, when it is the merge stage's; a refusal otherwise. */
function ownItem(repo: ReturnType<typeof workflowRepo>): WorkItem {
  const number = issueOfItem(runItem()?.item.key);
  const issue = `issue ${String(number)}`;
  const doc = readWorkItem(number);
  if (doc === null) throw new Error(`${issue} has no work item: intake has not recorded it`);
  if (!sameRepo(doc.subject.repo, repo)) {
    throw new Error(`${issue}'s work item is ${doc.subject.repo.host}/${doc.subject.repo.path}'s, not ${repo.host}/${repo.path}'s`);
  }
  if (!mergeAccepts(doc)) {
    const build = doc.facts.build?.status ?? 'none';
    throw new Error(`${issue} is not the merge stage's: build status ${build}, merge status ${doc.facts.merge?.status ?? 'none'}`);
  }
  return doc;
}

function main(): void {
  const ci = parseCiMode(input('ci').trim());
  const lane = parseLane('merge_lane', input('merge_lane').trim());
  const repo = workflowRepo();
  const doc = ownItem(repo);

  const answered = answer();
  const pr = itemPr(doc);
  const settle = { path: 'settle', item: doc.subject, pr, url: '', facts: null, base: null, record: doc.facts.merge ?? null, validation: null, protected: [], lane, ci, answer: answered } as const;
  const out = (start: MergeStart): void => emit(start);
  if (answered !== null && answered.effect !== 'merge') {
    out({ ...settle, settled: { status: answered.effect === 'return' ? 'returned' : 'parked', reason: `a maintainer answered ${answered.effect}` } });
    return;
  }
  if (pr === null) {
    out({ ...settle, settled: { status: 'parked', reason: 'the build record names no pull request' } });
    return;
  }
  const facts = readPr(pr, readMaintainers(repo));
  if (facts.state !== 'open') {
    const status = facts.state === 'merged' ? 'merged' : 'parked';
    out({ ...settle, url: facts.url, facts, settled: { status, reason: `${facts.url} was ${facts.state} before this run` } });
    return;
  }
  const base = readBase(repo);
  out({
    ...settle,
    path: stillWaits(facts, ci) ? 'wait' : 'judge',
    url: facts.url,
    facts,
    base,
    // The judge and the gate read an approval just given as the record will hold it.
    record: answered === null ? settle.record : { ...settle.record, approval: { head: answered.head, at: answered.at } },
    validation: latestValidation(doc),
    protected: protectedChanges(pr, listSetting(input('protected_paths'))),
    settled: null,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
