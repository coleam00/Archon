import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import {
  attentionQueueItems,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueItem,
  type AttentionQueueScope,
  type AttentionQueueSource,
  type ProjectRef,
} from '@archon/workflows/attention-queue';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { continuablePause } from '@archon/workflows/schemas/workflow-run';
import { z } from 'zod';
import { RunActionForbiddenError, type RunActor } from '../operations/run-authorization';
import {
  expectedGateForOccurrence,
  workflowOperationErrorMessage,
  type AttentionAnswerRequest,
  type GateAnswerOrigin,
  type WorkflowOperations,
} from '../operations/workflow-operations';

const log = createLogger('orchestrator.attention_tool');

/** The surface an answer from this tool is recorded under. */
const SURFACE = 'attention_tool';

export interface AttentionToolContext {
  actor: RunActor;
  operations: Pick<
    WorkflowOperations,
    'answerWorkflow' | 'respondToWorkflow' | 'assertRunActionAllowed'
  >;
  /** The queue the CLI's `workflow attention` and the API's attention routes read. */
  queue: AttentionQueueSource;
  /** Resolve a project the agent named: a codebase id, a codebase name or a project key. */
  resolveProject: (spec: string) => Promise<ProjectRef>;
  /** The chat's project, which a list covers by default; null lists the whole install. */
  codebaseId: string | null;
}

const ACTIONS = ['list', 'answer'] as const;

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    action: {
      kind: 'enum',
      values: [...ACTIONS],
      description:
        'list: the open attention items. answer: answer one item, named by its run and occurrence as list reports them.',
    },
    project: {
      kind: 'string',
      description:
        "For action=list: a project name, id or key, or 'all' for every project. Omit for this chat's project, or every project when the chat has none.",
    },
    run: {
      kind: 'string',
      description: "For action=answer: the item's full runId, as list reports it.",
    },
    occurrence: {
      kind: 'string',
      description:
        "For action=answer: the item's occurrence, as list reports it. The answer is refused when the item has since changed.",
    },
    choose: {
      kind: 'string',
      description:
        'For action=answer: a JSON array of the option ids to choose, e.g. ["approve"]. One id, except at a multi_select item. Omit for a message item, which takes only text.',
    },
    recommended: {
      kind: 'boolean',
      description:
        "For action=answer: true accepts the item's recommendation instead of naming an option. Refused when the item has none.",
    },
    text: {
      kind: 'string',
      description:
        "For action=answer: free text recorded with the answer, in the user's own words. Required for a message item and for the option `other`.",
    },
    confirm: {
      kind: 'boolean',
      description:
        'For action=answer: true records the answer. Omit first to get a preview to check with the user.',
    },
  },
  required: ['action'],
});

/**
 * The `attention` native tool: the chat agent's view of the attention queue. It lists
 * what needs someone across projects and answers one item, through the queue reader and
 * the answer operations every other surface uses.
 *
 * An item is addressed by its own `runId` and `occurrence`, and a list hands every item
 * to the agent as the queue describes it, so a field the queue adds reaches the agent
 * without a change here.
 *
 * A list reaches across projects, so it shows only the items the chat's actor may answer:
 * the rule an answer is held to. Whoever cannot answer an item does not read its prompt
 * or its paths through this tool.
 *
 * An answer is recorded and nothing more: an answered pause is a due continuation that a
 * continuation host continues, so one turn can answer any number of items.
 */
export function buildAttentionTool(ctx: AttentionToolContext): NativeTool {
  return {
    name: 'attention',
    description:
      'The attention queue: runs paused for a person, across projects. action=list shows each item with what it asks, its options and recommendation; action=answer answers one. Answering needs confirm=true.',
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const action = typeof input.action === 'string' ? input.action : '';
      try {
        switch (action) {
          case 'list':
            return await listItems(ctx, text(input.project));
          case 'answer':
            return await answerItem(ctx, input);
          default:
            return `attention: unknown action '${action}'. Use list or answer.`;
        }
      } catch (e: unknown) {
        log.error({ err: e, action, run: text(input.run) }, 'attention_tool.failed');
        return `attention error: ${workflowOperationErrorMessage(e, {})}`;
      }
    },
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function scopeFor(ctx: AttentionToolContext, project: string): Promise<AttentionQueueScope> {
  const spec = project !== '' ? project : (ctx.codebaseId ?? 'all');
  return spec === 'all'
    ? { kind: 'all' }
    : { kind: 'project', project: await ctx.resolveProject(spec) };
}

/** True when the chat's actor may answer `run`, by the rule the answer operations enforce. */
async function mayAnswer(
  ctx: AttentionToolContext,
  run: Parameters<WorkflowOperations['assertRunActionAllowed']>[0]
): Promise<boolean> {
  try {
    await ctx.operations.assertRunActionAllowed(run, ctx.actor, 'respond');
    return true;
  } catch (error) {
    if (error instanceof RunActionForbiddenError) return false;
    throw error;
  }
}

async function listItems(ctx: AttentionToolContext, project: string): Promise<string> {
  const scope = await scopeFor(ctx, project);
  const rows = splitAttentionRead(await ctx.queue.store.listAttentionQueueRows());
  const answerable = [];
  for (const run of rows.values) if (await mayAnswer(ctx, run)) answerable.push(run);
  const read = splitAttentionRead(await attentionQueueItems(ctx.queue, answerable));
  const items = selectAttentionQueue(read.values, { scope, labels: {}, order: { by: 'age' } });
  const where = scope.kind === 'all' ? 'every project' : `project ${scope.project.name}`;
  log.info({ scope: scope.kind, count: items.length }, 'attention_tool.list_completed');
  const lines = [
    items.length === 0
      ? `No open attention items in ${where}.`
      : `${String(items.length)} open attention item(s) in ${where}, oldest first:`,
  ];
  if (items.length > 0) lines.push(JSON.stringify(items, null, 1), HOW_TO_ANSWER);
  const withheld = rows.values.length - answerable.length;
  if (withheld > 0)
    lines.push(
      `${String(withheld)} more paused run(s) in the install are not listed: only the user who started a run, or an admin, may answer it.`
    );
  // A row that cannot be read has no readable owner, so it is counted and never identified.
  const unreadable = rows.degraded.length + read.degraded.length;
  if (unreadable > 0)
    lines.push(
      `${String(unreadable)} more paused run(s) in the install could not be read. \`archon workflow attention\` names them.`
    );
  return lines.join('\n');
}

const HOW_TO_ANSWER = [
  'Answer an item with action=answer, run=<runId>, occurrence=<occurrence>:',
  '- kind attention: choose=<JSON array of option ids> (one id, several only for form multi_select), or recommended=true; form message takes text only.',
  '- kind awaiting_response: choose=<JSON array with one decision id>, e.g. ["approve"] or ["reject"].',
  '- kind usage_limit continues by itself at resetAt; kind unreadable needs someone to look at the run. Neither takes an answer.',
].join('\n');

const chooseSchema = z.array(z.string().min(1)).min(1);

/** The `choose` argument: undefined when absent, the option ids, or null when malformed. */
function parseChoose(raw: unknown): string[] | undefined | null {
  if (raw === undefined || text(raw) === '') return undefined;
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = chooseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type Answerable = Extract<AttentionQueueItem, { kind: 'attention' | 'awaiting_response' }>;

/** What the agent asked to answer with, checked only for what this tool can tell. */
type Answer =
  | { kind: 'attention'; request: AttentionAnswerRequest }
  | { kind: 'gate'; decision: string; text: string | undefined };

function answerFor(item: Answerable, input: Record<string, unknown>): Answer | string {
  const choose = parseChoose(input.choose);
  if (choose === null)
    return 'attention: choose must be a JSON array of option ids, e.g. ["approve"].';
  const recommended = input.recommended === true;
  if (recommended && choose !== undefined)
    return 'attention: pass either choose or recommended, not both.';
  const said = text(input.text);
  const withText = said === '' ? {} : { text: said };
  if (item.kind === 'attention') {
    if (recommended) return { kind: 'attention', request: { recommended: true, ...withText } };
    return { kind: 'attention', request: { choose: choose ?? [], ...withText } };
  }
  // A gate takes one of its declared decisions; the operation names them when it is not one.
  if (recommended) return 'attention: a gate has no recommendation. Pass choose with one decision.';
  const [decision, ...rest] = choose ?? [];
  if (decision === undefined || rest.length > 0)
    return 'attention: a gate takes exactly one decision in choose, e.g. ["approve"].';
  return { kind: 'gate', decision, text: said === '' ? undefined : said };
}

function describe(answer: Answer): string {
  if (answer.kind === 'gate') return `'${answer.decision}'`;
  if ('recommended' in answer.request) return 'the recommended option';
  return answer.request.choose.length === 0
    ? 'the text'
    : answer.request.choose.map(option => `'${option}'`).join(', ');
}

/** The answerable item `runId` stands for at `occurrence`, or why there is none to answer. */
async function answerableItem(
  ctx: AttentionToolContext,
  runId: string,
  occurrence: string
): Promise<Answerable | string> {
  const item = await readAttentionQueueItem(ctx.queue, runId);
  if (item === undefined) return `attention: no run ${runId}. Call action=list for the open items.`;
  if (item === null) return `attention: run ${runId} has no open attention item.`;
  if (item.kind === 'usage_limit')
    return `attention: run ${item.runId} waits for a usage limit and continues by itself at ${item.resetAt}. It takes no answer.`;
  if (item.kind === 'unreadable')
    return `attention: run ${item.runId} cannot be read (${item.reason}: ${item.detail}). Someone has to look at it; it takes no answer.`;
  if (item.occurrence !== occurrence)
    return `attention: the item on run ${item.runId} is now at occurrence ${item.occurrence}, not ${occurrence}. Call action=list and answer what it asks now.`;
  return item;
}

async function answerItem(
  ctx: AttentionToolContext,
  input: Record<string, unknown>
): Promise<string> {
  const runId = text(input.run);
  if (runId === '') return 'attention: action=answer requires run.';
  if (typeof input.occurrence !== 'string')
    return 'attention: action=answer requires occurrence, as list reports it.';
  const item = await answerableItem(ctx, runId, input.occurrence.trim());
  if (typeof item === 'string') return item;
  const answer = answerFor(item, input);
  if (typeof answer === 'string') return answer;
  if (input.confirm !== true) {
    log.info({ runId: item.runId }, 'attention_tool.confirm_preview');
    return (
      `This will answer run ${item.runId} (${item.workflow}) with ${describe(answer)}. It asks:\n> ${item.message.replace(/\n/g, '\n> ')}\n` +
      'Confirm with the user, then call attention again with confirm: true to record it.'
    );
  }
  return recordAnswer(ctx, item, answer);
}

/** Record `answer` on the item, pinned to the occurrence it was read at, and say what follows. */
async function recordAnswer(
  ctx: AttentionToolContext,
  item: Answerable,
  answer: Answer
): Promise<string> {
  const subject = `run ${item.runId} (${item.workflow})`;
  const holder = await ctx.queue.store.getWorkflowRun(item.runId);
  if (holder === null) return `attention: run ${item.runId} no longer exists.`;
  const origin: GateAnswerOrigin = {
    via: SURFACE,
    expectedGate: expectedGateForOccurrence(holder, item.occurrence),
  };
  if (answer.kind === 'attention') {
    await ctx.operations.answerWorkflow(item.runId, answer.request, ctx.actor, origin);
  } else {
    const result = await ctx.operations.respondToWorkflow(
      item.runId,
      answer.decision,
      answer.text,
      ctx.actor,
      origin
    );
    if ('cancelled' in result && result.cancelled)
      return `Answered ${subject} with ${describe(answer)}. The gate has no rework path, so the run is cancelled and nothing further runs.`;
  }
  log.info({ runId: item.runId, kind: item.kind }, 'attention_tool.answered');
  // Judged on the run as it was answered: a host may already have continued it by now.
  const continues =
    continuablePause(holder) !== undefined
      ? `A running Archon server continues the run on its own. With no server running, continue it with \`archon workflow resume ${item.runId}\`.`
      : `It does not continue from here: run \`archon workflow resume ${item.runId}\` from the CLI in its project.`;
  return `Answered ${subject} with ${describe(answer)}. ${continues}`;
}
