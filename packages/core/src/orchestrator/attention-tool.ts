import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import {
  listAttentionQueue,
  selectAttentionQueue,
  type AttentionQueueScope,
  type AttentionQueueSource,
  type ProjectRef,
} from '@archon/workflows/attention-queue';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { z } from 'zod';
import {
  answerAttentionItem,
  mayAnswerAttentionItem,
  type AttentionItemAnswerResult,
} from '../operations/attention-items';
import type { RunActor } from '../operations/run-authorization';
import {
  workflowOperationErrorMessage,
  type AttentionAnswerRequest,
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
        'list: the open attention items. answer: answer one item, named by the ref list reports for it.',
    },
    project: {
      kind: 'string',
      description:
        "For action=list: a project name, id or key, or 'all' for every project. Omit for this chat's project, or every project when the chat has none.",
    },
    item: {
      kind: 'string',
      description:
        "For action=answer: the item's ref, copied exactly as list reports it. The answer is refused when the item has since changed.",
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
  },
  required: ['action'],
});

/**
 * The `attention` native tool: the chat agent's view of the attention queue. It lists
 * what needs someone across projects and answers one item, through the queue reader and
 * the answer operations every other surface uses.
 *
 * An item is addressed by its `ref`, which this tool hands out and takes back without
 * reading: the answer operation (`answerAttentionItem`) reads it. A list hands every item to
 * the agent as the queue describes it, so a field the queue adds reaches the agent without
 * a change here.
 *
 * A list reaches across projects, so it shows only the items the chat's actor may answer:
 * the rule an answer is held to. Whoever cannot answer an item does not read its prompt
 * or its paths through this tool.
 *
 * An answer is recorded and nothing more: an answered pause is a due continuation that a
 * continuation host continues, so one turn can answer any number of items.
 *
 * There is no confirm step. A two-call preview was tried and the model passed the confirm
 * on its first call every time, so it protected nothing while the description promised it
 * did. What holds is the permission check, the record of who answered through what, and a
 * result that repeats what was answered. The description's "one instruction answers one
 * item" is guidance to the model, not a guard.
 */
export function buildAttentionTool(ctx: AttentionToolContext): NativeTool {
  return {
    name: 'attention',
    description:
      'The attention queue: runs paused for a person, across projects. action=list shows each item with what it asks, its options and recommendation; action=answer answers one: the answer is recorded at once and cannot be taken back, so answer only the item the user means. One instruction from the user answers one item, unless they name several.',
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
        log.error({ err: e, action, item: text(input.item) }, 'attention_tool.failed');
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

async function listItems(ctx: AttentionToolContext, project: string): Promise<string> {
  const scope = await scopeFor(ctx, project);
  const { values, degraded } = splitAttentionRead(await listAttentionQueue(ctx.queue));
  const open = selectAttentionQueue(values, { scope, labels: {}, order: { by: 'age' } });
  const items = [];
  for (const item of open) if (await mayAnswerAttentionItem(ctx, item, ctx.actor)) items.push(item);
  const where = scope.kind === 'all' ? 'every project' : `project ${scope.project.name}`;
  log.info({ scope: scope.kind, count: items.length }, 'attention_tool.list_completed');
  const lines = [
    items.length === 0
      ? `No open attention items in ${where}.`
      : `${String(items.length)} open attention item(s) in ${where}, oldest first:`,
  ];
  if (items.length > 0) lines.push(JSON.stringify(items, null, 1), HOW_TO_ANSWER);
  const withheld = open.length - items.length;
  if (withheld > 0)
    lines.push(
      `${String(withheld)} more item(s) in ${where} are not listed: only the user who started a run, or an admin, may answer it.`
    );
  // A row that cannot be read has no readable owner, so it is counted and never identified.
  if (degraded.length > 0)
    lines.push(
      `${String(degraded.length)} more paused run(s) in the install could not be read. \`archon workflow attention\` names them.`
    );
  return lines.join('\n');
}

const HOW_TO_ANSWER = [
  'Answer an item with action=answer, item=<its ref>:',
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

/** What the agent asked to answer with, or why its arguments cannot be one. */
function answerFrom(input: Record<string, unknown>): AttentionAnswerRequest | string {
  const choose = parseChoose(input.choose);
  if (choose === null)
    return 'attention: choose must be a JSON array of option ids, e.g. ["approve"].';
  const recommended = input.recommended === true;
  if (recommended && choose !== undefined)
    return 'attention: pass either choose or recommended, not both.';
  const said = text(input.text);
  const withText = said === '' ? {} : { text: said };
  return recommended ? { recommended: true, ...withText } : { choose: choose ?? [], ...withText };
}

function describe(answer: AttentionAnswerRequest): string {
  const said = answer.text;
  if ('recommended' in answer) return withText('the recommended option', said);
  return answer.choose.length === 0
    ? `the text "${said ?? ''}"`
    : withText(answer.choose.map(option => `'${option}'`).join(', '), said);
}

/** `chosen`, followed by the text that goes with it when there is any. */
function withText(chosen: string, said: string | undefined): string {
  return said === undefined ? chosen : `${chosen} and the text "${said}"`;
}

/** Why the item `ref` names was not answered, in words the agent can act on. */
function notAnswered(
  ref: string,
  result: Exclude<AttentionItemAnswerResult, { kind: 'answered' }>
): string {
  switch (result.kind) {
    case 'unknown':
      return `attention: nothing matches item '${ref}'. Call action=list and copy an item's ref.`;
    case 'none':
      return `attention: item '${ref}' is no longer open.`;
    case 'moved':
      return `attention: item '${ref}' is over; its run now asks something else, as item '${result.item.ref}'. Call action=list and answer what it asks now.`;
    case 'takes_no_answer':
      return result.item.kind === 'usage_limit'
        ? `attention: item '${ref}' waits for a usage limit and continues by itself at ${result.item.resetAt}. It takes no answer.`
        : `attention: item '${ref}' cannot be read (${result.item.reason}: ${result.item.detail}). Someone has to look at its run; it takes no answer.`;
    case 'refused':
      return result.reason === 'gate_has_no_recommendation'
        ? 'attention: a gate has no recommendation. Pass choose with one decision.'
        : 'attention: a gate takes exactly one decision in choose, e.g. ["approve"].';
  }
}

/** Answer the item the agent named, through the one answer operation, and say what follows. */
async function answerItem(
  ctx: AttentionToolContext,
  input: Record<string, unknown>
): Promise<string> {
  const ref = text(input.item);
  if (ref === '')
    return "attention: action=answer requires item, the item's ref as list reports it.";
  const answer = answerFrom(input);
  if (typeof answer === 'string') return answer;
  const result = await answerAttentionItem(ctx, ref, answer, ctx.actor, SURFACE);
  if (result.kind !== 'answered') return notAnswered(ref, result);
  const { item } = result;
  const subject = `run ${item.run.id} (${item.run.workflow})`;
  if (result.cancelled)
    return `Answered ${subject} with ${describe(answer)}. The gate has no rework path, so the run is cancelled and nothing further runs.`;
  log.info({ runId: item.run.id, kind: item.kind }, 'attention_tool.answered');
  const continues = result.continues
    ? `The run continues on its own while an Archon server is running; \`archon workflow resume ${item.run.id}\` continues it otherwise.`
    : `It does not continue from here: run \`archon workflow resume ${item.run.id}\` from the CLI in its project.`;
  // The result repeats what was asked, so the user sees at once what the answer went to.
  return `Answered ${subject} with ${describe(answer)}. It asked:\n> ${item.message.replace(/\n/g, '\n> ')}\n${continues}`;
}
