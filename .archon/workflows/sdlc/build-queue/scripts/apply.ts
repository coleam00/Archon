/**
 * Check the run's decision, perform the writes it declared, and read each one back.
 *
 * The decision is the last agent's that ran: answer's over route's. At the round cap an
 * answer that asks is the scope question. A route that launched is answered after its round, so its own decision is
 * recorded only when it asked. A push the answer declared is made whatever the run
 * decided, since a round's work belongs on its pull request even when a person is
 * asked about it. The push comes first, then the work item, in one conditional
 * write that also releases the claim unless a person is asked; a run that asks keeps
 * its claim until the ruling node records the answer.
 *
 * Bound inputs: INPUTS_PATH and INPUTS_ITEM from facts; INPUTS_ROUTE,
 * INPUTS_ENDING (archon-ship's report) and INPUTS_ANSWER, each the whole output of its
 * node, "null" when it was skipped; INPUTS_AT_CAP from facts.
 */

import type { ApplyDecision, AskedBy, BuildAttention, BuildRound, BuildStatus } from '../../.shared/build.ts';
import { withBuild } from '../../.shared/build.ts';
import { forgeSource, parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';
import { pushHead } from '../../.shared/push.ts';
import { attentionOptions, checkAttention, type DecisionEntry, renderAttention, withOther } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

interface RouteOutput {
  readonly decision: 'launch' | 'ask';
  readonly brief: string;
  readonly reason: string;
  readonly attention: BuildAttention | null;
}

interface AnswerOutput {
  readonly decision: 'done' | 'continue' | 'ask';
  readonly brief: string;
  readonly push: QualifiedPr | null;
  readonly reason: string;
  readonly attention: BuildAttention | null;
}

interface ShipReport {
  readonly delivered: boolean;
  readonly reason: string;
  readonly pr_url: string;
  readonly summary: string;
}

/** What the run decided, before anything is written. */
type Decision =
  | { readonly kind: 'parked'; readonly reason: string }
  | { readonly kind: 'launch'; readonly brief: string; readonly reason: string }
  | { readonly kind: 'ready'; readonly reason: string }
  | { readonly kind: 'continue'; readonly brief: string; readonly reason: string }
  | {
      readonly kind: 'asked';
      readonly by: AskedBy;
      readonly attention: BuildAttention;
      readonly brief: string;
      readonly reason: string;
    };

function asked(by: AskedBy, attention: BuildAttention | null, brief: string, reason: string): Decision {
  if (attention === null) throw new Error(`the ${by} decision asks without an attention item`);
  checkAttention(attention);
  return { kind: 'asked', by, attention: withOther(attention, 'continue'), brief, reason };
}

function decide(
  path: string,
  route: RouteOutput | null,
  answer: AnswerOutput | null,
  atCap: boolean
): Decision {
  if (path === 'closed') return { kind: 'parked', reason: 'the issue is closed' };
  if (answer !== null) {
    if (answer.decision === 'done') return { kind: 'ready', reason: answer.reason };
    if (answer.decision === 'ask') return asked(atCap ? 'scope' : 'stop', answer.attention, answer.brief, answer.reason);
    if (answer.brief.trim() === '') throw new Error('a continue decision has no brief to launch from');
    return { kind: 'continue', brief: answer.brief, reason: answer.reason };
  }
  if (route === null) throw new Error(`the ${path} path reached apply with no decision`);
  if (route.decision === 'ask') return asked('route', route.attention, route.brief, route.reason);
  // A launch is answered after its round, so a run never ends on one.
  return { kind: 'launch', brief: route.brief, reason: route.reason };
}

/** Push the checkout's commits to the pull request's head; git refuses anything but a fast-forward. */
function pushTo(pr: QualifiedPr): string {
  const view = viewPr(pr, forgeSource());
  if (view.pr.state !== 'open') throw new Error(`${view.pr.url} is ${view.pr.state}; nothing is pushed to it`);
  if (view.pr.head_revision === gitOrThrow('rev-parse', 'HEAD')) return 'its head already holds the checkout';
  const pushed = pushHead({ repo: pr.repo, head_repo: view.pr.head_repo, head: view.pr.head });
  return `pushed ${pushed} to ${view.pr.head}`;
}

const STATUS = {
  parked: 'parked',
  ready: 'ready',
  continue: 'next',
  asked: 'asking',
} as const satisfies Record<Exclude<Decision['kind'], 'launch'>, BuildStatus>;

function summaryOf(item: QualifiedPr | null, decision: Decision): string {
  const subject = item === null ? '' : `Issue ${String(item.number)}: `;
  return `${subject}${decision.kind}. ${decision.reason}`;
}

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  if (path === 'idle') {
    emit({
      decision: 'idle',
      summary: 'No item waits for the build queue.',
      attention: '',
      options: [],
      class: '',
      asked: null,
    });
    return;
  }
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const ending = nullableJson(process.env.INPUTS_ENDING) as ShipReport | null;
  const at = new Date().toISOString();
  const round: BuildRound | null =
    ending === null ? null : { run_id: runId, at, ...ending, artifacts: artifactsDir() };
  const answer = nullableJson(process.env.INPUTS_ANSWER) as AnswerOutput | null;
  const decision = decide(
    path,
    nullableJson(process.env.INPUTS_ROUTE) as RouteOutput | null,
    answer,
    text(process.env.INPUTS_AT_CAP) === 'true'
  );
  const push = answer?.push ?? null;
  const asking = decision.kind === 'asked' ? decision : null;
  const attention =
    asking === null
      ? ''
      : renderAttention(`Build queue, issue ${String(item.number)}: ${asking.by} decision`, asking.attention);
  const links = [
    ...(round === null ? [] : [round.pr_url, round.artifacts].filter(link => link !== '')),
    ...(asking?.attention.links ?? []),
  ];
  const result = {
    decision: decision.kind satisfies ApplyDecision,
    summary: summaryOf(item, decision),
    attention,
    options: asking === null ? [] : attentionOptions(asking.attention),
    class: asking?.by ?? '',
    asked:
      asking === null ? null : { attention: asking.attention, brief: asking.brief, by: asking.by },
  };

  if (decision.kind === 'launch') throw new Error('a launch reached apply without its round');

  const pushed = push === null ? null : pushTo(push);
  const entry: DecisionEntry = {
    at,
    run_id: runId,
    decision: asking === null ? decision.kind : `ask ${asking.by}`,
    reason: pushed === null ? decision.reason : `${decision.reason} (${pushed})`,
    links,
  };
  updateClaimed(item, runId, doc =>
    withBuild(doc, {
      at,
      run_id: runId,
      round,
      entry,
      status: STATUS[decision.kind],
      brief: decision.kind === 'continue' ? decision.brief : '',
      release: asking === null,
    })
  );
  emit({ ...result, summary: pushed === null ? result.summary : `${result.summary} (${pushed})` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue apply: ${error instanceof Error ? error.message : String(error)}`);
}
