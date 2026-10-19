/**
 * Check the run's decision, perform the writes it declared, and read each one back.
 *
 * The decision is the last agent's that ran: answer's over route's. At the round cap an
 * answer that asks is the scope question. A route that launched is answered after
 * its round; route is recorded when it asks or finishes an already reviewed PR.
 * A push the answer declared is made whatever the run
 * decided, since a round's work belongs on its pull request even when a person is
 * asked about it. The push comes first, then the work item, in one conditional
 * write that also releases the claim unless a person is asked; a run that asks keeps
 * its claim until the ruling node records the answer. A continue then starts the item's
 * next round at once, on the run config this run started with; if that launch fails,
 * the item waits for the next queue run.
 *
 * Bound inputs: INPUTS_PATH and INPUTS_ITEM from facts; INPUTS_ROUTE,
 * INPUTS_ENDING (archon-ship's report) and INPUTS_ANSWER, each the whole output of its
 * node, "null" when it was skipped; INPUTS_AT_CAP and INPUTS_PULL_REQUEST from facts.
 */

import type { ApplyDecision, AskedBy, BuildAttention, BuildRound, BuildStatus, ROUTE_DECISIONS } from '../../.shared/build.ts';
import { withBuild } from '../../.shared/build.ts';
import { forgeSource, invokeForge, record, parseQualifiedPr, type QualifiedPr, type PrRecord } from '../../.shared/forge.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { launchNextRound } from '../../.shared/launch.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { ghGraphql, ghIssueComments, ghWorkflowApprovalClear, setPrDraft, viewPr } from '../../.shared/pr.ts';
import { checksOf, ROLLUP } from '../../.shared/merge.ts';
import { readReviewStamp } from '../../.shared/review-comment.ts';
import { pushHead } from '../../.shared/push.ts';
import { attentionOptions, checkAttention, type DecisionEntry, renderAttention, withOther } from '../../.shared/queue.ts';
import { idleSummary, stuckItems } from '../../.shared/stuck.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

type RouteDecision = (typeof ROUTE_DECISIONS)[number];
type RouteOutput = {
  readonly brief: string;
  readonly reason: string;
  readonly attention: BuildAttention | null;
} & (
  | { readonly decision: Extract<RouteDecision, 'ready'>; readonly ready_head: string }
  | { readonly decision: Exclude<RouteDecision, 'ready'>; readonly ready_head: null }
);

function parseRoute(value: string | undefined): RouteOutput | null {
  const route = nullableJson(value) as
    | (Omit<RouteOutput, 'decision' | 'ready_head'> & { decision: RouteDecision; ready_head: unknown })
    | null;
  if (route === null) return null;
  if (route.decision === 'ready') {
    const head = route.ready_head;
    if (typeof head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head))
      throw new Error('route ready_head must be a full reviewed head SHA for ready');
    return { ...route, decision: 'ready', ready_head: head };
  }
  if (route.ready_head !== null) throw new Error('route ready_head must be null for launch or ask');
  return { ...route, decision: route.decision, ready_head: null };
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
  if (route.decision === 'ready') return { kind: 'ready', reason: route.reason };
  if (route.decision === 'ask') return asked('route', route.attention, route.brief, route.reason);
  // A launch is answered after its round, so a run never ends on one.
  return { kind: 'launch', brief: route.brief, reason: route.reason };
}

/** Push the checkout's commits to the pull request's head; git refuses anything but a fast-forward. */
function pushTo(pr: QualifiedPr): string {
  const view = viewPr(pr, forgeSource());
  if (view.pr.state !== 'open') throw new Error(`${view.pr.url} is ${view.pr.state}; nothing is pushed to it`);
  if (view.pr.head_repo === null) throw new Error(`${view.pr.url}'s head repository is gone; nothing is pushed`);
  if (view.pr.head_revision === gitOrThrow('rev-parse', 'HEAD')) return 'its head already holds the checkout';
  const pushed = pushHead({ repo: pr.repo, head_repo: view.pr.head_repo, head: view.pr.head });
  return `pushed ${pushed} to ${view.pr.head}`;
}

function verifyReady(ref: QualifiedPr, head: string): void {
  const source = forgeSource();
  const logins: unknown = nullableJson(process.env.INPUTS_MAINTAINERS);
  if (!Array.isArray(logins) || !logins.every((login): login is string => typeof login === 'string'))
    throw new Error('route-ready requires maintainer logins from facts');
  const maintainers = new Set(logins.map(login => login.toLowerCase()));
  const comments = source === 'gh'
    ? ghIssueComments(ref)
    : (() => {
        const value = invokeForge('pr.comments', { ref });
        if (!Array.isArray(value?.comments)) throw new Error('forge returned no PR comments');
        return value.comments.map((value: unknown) => {
          const comment = record(value);
          if (typeof comment?.body !== 'string') throw new Error('forge returned an invalid PR comment');
          const login = record(comment.author)?.login;
          return { body: comment.body, author: typeof login === 'string' ? login : null };
        });
      })();
  const reviews = comments.flatMap(comment => {
    const stamp = readReviewStamp(comment.body);
    return stamp !== null && comment.author !== null && maintainers.has(comment.author.toLowerCase()) ? [stamp] : [];
  });
  if (reviews.length !== 1 || reviews[0]?.ready !== true || reviews[0].reviewed !== head)
    throw new Error(`route-ready requires one trusted Ready review at ${head}`);
  if (source === 'forge') {
    const checks = invokeForge('checks.state', { ref });
    if (checks?.revision !== head || record(checks.summary)?.state !== 'green' || checks.approvalPending !== false)
      throw new Error(`route-ready requires green CI and clear approval evidence at ${head}`);
  } else {
    const data = ghGraphql(ref.repo.host, `query($owner:String!,$name:String!,$head:GitObjectID!) {
      repository(owner:$owner,name:$name) { object(oid:$head) { ... on Commit { oid ${ROLLUP} } } }
    }`, { owner: ref.repo.path.split('/')[0], name: ref.repo.path.split('/')[1], head });
    const commit = record(record(data.repository)?.object);
    if (commit?.oid !== head || checksOf(commit.statusCheckRollup).state !== 'green')
      throw new Error(`route-ready requires green CI at ${head}`);
    if (!ghWorkflowApprovalClear(ref.repo, head))
      throw new Error(`route-ready requires clear workflow approval evidence at ${head}`);
  }
}

function finishReviewedPr(pr: PrRecord | null, head: string): PrRecord {
  if (pr === null) throw new Error('route-ready has no pull request');
  const ref = { repo: pr.repo, number: pr.number };
  const source = forgeSource();
  const before = viewPr(ref, source).pr;
  if (before.state !== 'open' || before.head_revision !== head)
    throw new Error(`${before.url} is ${before.state} at ${before.head_revision}; expected open at ${head}`);
  verifyReady(ref, head);
  let after: PrRecord;
  try {
    after = setPrDraft(ref, false, source);
  } catch (error) {
    throw new Error(`draft conversion attempted for ${before.url} at ${head}; inspect the PR before retrying: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (after.state !== 'open' || after.is_draft || after.head_revision !== head)
    throw new Error(`draft conversion may have landed: ${after.url} is ${after.state}, draft=${String(after.is_draft)} at ${after.head_revision}; expected open and non-draft at ${head}`);
  return after;
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

/** The summary once the writes are done; a continue starts the next round now instead of waiting for the next queue run. */
function afterWrite(summary: string, pushed: string | null, decision: Decision, item: QualifiedPr, runId: string): string {
  const written = pushed === null ? summary : `${summary} (${pushed})`;
  return decision.kind === 'continue' ? `${written}; ${launchNextRound(item, runId)}` : written;
}

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  if (path === 'idle') {
    emit({
      decision: 'idle',
      summary: idleSummary('No item waits for the build queue.', stuckItems(text(process.env.WORKFLOW_ID))),
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
  const route = parseRoute(process.env.INPUTS_ROUTE);
  const decision = decide(
    path,
    route,
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

  let readyEvidence: string | null = null;
  if (answer === null && route?.decision === 'ready') {
    const pr = nullableJson(process.env.INPUTS_PULL_REQUEST) as PrRecord | null;
    const after = finishReviewedPr(pr, route.ready_head);
    readyEvidence = `${after.url} Ready and green at ${route.ready_head}`;
    links.push(after.url);
  }
  const pushed = push === null ? null : pushTo(push);
  const entry: DecisionEntry = {
    at,
    run_id: runId,
    decision: asking === null ? decision.kind : `ask ${asking.by}`,
    reason: `${decision.reason}${readyEvidence === null ? '' : ` (${readyEvidence})`}${pushed === null ? '' : ` (${pushed})`}`,
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
  emit({ ...result, summary: afterWrite(result.summary, pushed, decision, item, runId) });
}

try {
  main();
} catch (error) {
  refuse(`build-queue apply: ${error instanceof Error ? error.message : String(error)}`);
}
