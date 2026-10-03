import { providerChunkSchema, subtaskTerminalStatusSchema, type ProviderChunk } from './events';
import { providerFailureSchema, type ProviderFailureClass } from './failure';

/**
 * Checks any provider, built in or a plugin, against the contract. The provider owns its
 * fixtures (how to drive its SDK into each state); these checks read only what it emitted.
 * Each check returns one line per violation, so an empty list means the provider conforms.
 */

/** One way to make the provider fail, the class it must report, and the vendor text it must keep. */
export interface ProviderFailureCase {
  name: string;
  expected: ProviderFailureClass;
  /** Vendor text the failure's `evidence` must contain: the class never replaces the evidence. */
  evidence: string;
  /** Runs one provider turn and yields its stream chunks. */
  run: () => AsyncIterable<unknown>;
}

function isResultChunk(
  chunk: unknown
): chunk is { type: 'result'; failure?: unknown; isError?: unknown } {
  return (
    typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'result'
  );
}

/**
 * A failed turn ends in exactly one result whose `failure` parses, carries the expected
 * class and keeps the vendor's evidence, and which still sets `isError` for readers that
 * do not read `failure` yet.
 */
export async function checkFailureClasses(
  cases: readonly ProviderFailureCase[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const failureCase of cases) {
    const results: { failure?: unknown; isError?: unknown }[] = [];
    try {
      for await (const chunk of failureCase.run()) {
        if (isResultChunk(chunk)) results.push(chunk);
      }
    } catch (error) {
      violations.push(
        `${failureCase.name}: threw instead of reporting a typed failure (${(error as Error).message})`
      );
      continue;
    }
    if (results.length !== 1) {
      violations.push(`${failureCase.name}: expected one result, got ${String(results.length)}`);
      continue;
    }
    const { failure, isError } = results[0];
    if (failure === undefined) {
      violations.push(`${failureCase.name}: result carries no failure`);
      continue;
    }
    const parsed = providerFailureSchema.safeParse(failure);
    if (!parsed.success) {
      violations.push(`${failureCase.name}: failure is malformed (${parsed.error.message})`);
      continue;
    }
    if (parsed.data.class !== failureCase.expected) {
      violations.push(
        `${failureCase.name}: reported ${parsed.data.class}, expected ${failureCase.expected}`
      );
    }
    if (!parsed.data.evidence.includes(failureCase.evidence)) {
      violations.push(
        `${failureCase.name}: evidence does not keep the vendor text "${failureCase.evidence}"`
      );
    }
    if (isError !== true) {
      violations.push(`${failureCase.name}: a failed result does not set isError`);
    }
  }
  return violations;
}

/** One provider turn, for checks that hold for every turn whether it succeeds or fails. */
export interface ProviderTurnCase {
  name: string;
  /** Runs one provider turn and yields its stream chunks. */
  run: () => AsyncIterable<unknown>;
}

function chunkType(chunk: unknown): unknown {
  return typeof chunk === 'object' && chunk !== null
    ? (chunk as { type?: unknown }).type
    : undefined;
}

/**
 * Every turn ends in exactly one `settled`, sent as the last chunk, after the turn's
 * `result`. The engine finishes a node on it, so a provider that never sends it keeps the
 * node open until its stream ends, and one that sends it early ends the node while work
 * still runs.
 */
export async function checkSettled(cases: readonly ProviderTurnCase[]): Promise<string[]> {
  const violations: string[] = [];
  for (const turnCase of cases) {
    const types: unknown[] = [];
    try {
      for await (const chunk of turnCase.run()) types.push(chunkType(chunk));
    } catch (error) {
      violations.push(`${turnCase.name}: threw instead of settling (${(error as Error).message})`);
      continue;
    }
    const settledAt = types.indexOf('settled');
    const settledCount = types.filter(type => type === 'settled').length;
    if (settledCount !== 1) {
      violations.push(`${turnCase.name}: expected one settled, got ${String(settledCount)}`);
      continue;
    }
    if (settledAt !== types.length - 1) {
      violations.push(`${turnCase.name}: settled is not the last chunk`);
    }
    if (!types.slice(0, settledAt).includes('result')) {
      violations.push(`${turnCase.name}: settled arrives before any result`);
    }
  }
  return violations;
}

const TERMINAL_SUBTASK_STATUSES: ReadonlySet<string> = new Set(subtaskTerminalStatusSchema.options);

/**
 * The stream speaks the contract's vocabulary, and tool calls and subtasks are closed by the
 * provider, never by the engine:
 *  1. every chunk parses with `providerChunkSchema`;
 *  2. every `tool_call` has a unique `toolCallId` and exactly one `tool_call_update` for it,
 *     before the next `result` (an interrupted call closes as `cancelled`). A turn whose
 *     background work outlives its first `result` may start calls after it; those close
 *     before the following `result`;
 *  3. no `tool_call_update` arrives without an earlier `tool_call` for its id;
 *  4. every subtask's last status before `settled` is `completed`, `failed` or `stopped`.
 *     A stream that never settles is reported by `checkSettled`.
 */
export async function checkEventVocabulary(cases: readonly ProviderTurnCase[]): Promise<string[]> {
  const violations: string[] = [];
  for (const turnCase of cases) {
    const chunks: ProviderChunk[] = [];
    try {
      let index = 0;
      for await (const raw of turnCase.run()) {
        const parsed = providerChunkSchema.safeParse(raw);
        if (parsed.success) chunks.push(parsed.data);
        else {
          violations.push(
            `${turnCase.name}: rule 1, chunk ${String(index)} (type ${JSON.stringify(chunkType(raw))}) is not a provider chunk (${parsed.error.message})`
          );
        }
        index++;
      }
    } catch (error) {
      violations.push(`${turnCase.name}: threw (${(error as Error).message})`);
      continue;
    }
    violations.push(...toolAndSubtaskClosure(chunks).map(v => `${turnCase.name}: ${v}`));
  }
  return violations;
}

/** Rules 2 to 4 over the chunks that parsed. */
function toolAndSubtaskClosure(chunks: readonly ProviderChunk[]): string[] {
  const violations: string[] = [];
  const startedCalls = new Set<string>();
  const openCalls = new Set<string>();
  /** Calls already reported open at a `result`; their late update is not reported again. */
  const lateCalls = new Set<string>();
  const openSubtasks = new Set<string>();
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'tool_call':
        if (startedCalls.has(chunk.toolCallId)) {
          violations.push(`rule 2, tool call ${chunk.toolCallId} is started twice`);
        } else {
          startedCalls.add(chunk.toolCallId);
          openCalls.add(chunk.toolCallId);
        }
        break;
      case 'tool_call_update':
        if (!startedCalls.has(chunk.toolCallId)) {
          violations.push(`rule 3, tool call ${chunk.toolCallId} is updated before it starts`);
        } else if (!openCalls.delete(chunk.toolCallId) && !lateCalls.has(chunk.toolCallId)) {
          violations.push(`rule 2, tool call ${chunk.toolCallId} is closed twice`);
        }
        break;
      case 'subtask':
        if (TERMINAL_SUBTASK_STATUSES.has(chunk.status)) openSubtasks.delete(chunk.taskId);
        else openSubtasks.add(chunk.taskId);
        break;
      case 'result':
        for (const toolCallId of openCalls) {
          violations.push(`rule 2, tool call ${toolCallId} is still open at a result`);
          lateCalls.add(toolCallId);
        }
        openCalls.clear();
        break;
      case 'settled':
        for (const taskId of openSubtasks) {
          violations.push(`rule 4, subtask ${taskId} is still open at settled`);
        }
        openSubtasks.clear();
        break;
    }
  }
  for (const toolCallId of openCalls) {
    violations.push(`rule 2, tool call ${toolCallId} is never closed`);
  }
  return violations;
}

/**
 * Every result of a successful turn names the session the turn ran in. The engine records
 * it on the node record, which is how a user finds the session to resume it outside Archon.
 */
export async function checkSessionIdReported(
  cases: readonly ProviderTurnCase[]
): Promise<string[]> {
  const violations: string[] = [];
  for (const turnCase of cases) {
    let results = 0;
    let unnamed = 0;
    try {
      for await (const chunk of turnCase.run()) {
        if (!isResultChunk(chunk)) continue;
        results++;
        const { sessionId } = chunk as { sessionId?: unknown };
        if (typeof sessionId !== 'string' || sessionId === '') unnamed++;
      }
    } catch {
      // checkSettled reports the throw.
      continue;
    }
    if (unnamed > 0) {
      violations.push(
        `${turnCase.name}: ${String(unnamed)} of ${String(results)} results carry no sessionId`
      );
    }
  }
  return violations;
}

/**
 * The `toolTurn` fixture must exercise what rule 2 is about: at least two tool calls, one of
 * them interrupted and closed as `cancelled`. A smaller fixture would pass rule 2 vacuously.
 */
async function checkToolTurnShape(toolTurn: ProviderTurnCase): Promise<string[]> {
  let calls = 0;
  let cancelled = 0;
  try {
    for await (const raw of toolTurn.run()) {
      const parsed = providerChunkSchema.safeParse(raw);
      if (!parsed.success) continue;
      if (parsed.data.type === 'tool_call') calls++;
      if (parsed.data.type === 'tool_call_update' && parsed.data.status === 'cancelled') {
        cancelled++;
      }
    }
  } catch {
    // checkEventVocabulary reports the throw.
    return [];
  }
  return calls >= 2 && cancelled >= 1
    ? []
    : [
        `${toolTurn.name}: the tool turn needs two tool calls and one cancelled, got ${String(calls)} and ${String(cancelled)}`,
      ];
}

/** Everything a provider supplies to be checked. Later checks add their own fixtures here. */
export interface ProviderConformanceSuite {
  failureCases: readonly ProviderFailureCase[];
  /** Turns that succeed, including one whose result arrives before its work drains. */
  turns: readonly ProviderTurnCase[];
  /**
   * A turn with two tool calls, one of them interrupted. A provider without tools omits it.
   */
  toolTurn?: ProviderTurnCase;
}

export async function runProviderConformance(suite: ProviderConformanceSuite): Promise<string[]> {
  const toolTurns = suite.toolTurn ? [suite.toolTurn] : [];
  return [
    ...(await checkFailureClasses(suite.failureCases)),
    // A failed turn settles too.
    ...(await checkSettled([...suite.turns, ...toolTurns, ...suite.failureCases])),
    // Every fixture streams the vocabulary, a failed turn included.
    ...(await checkEventVocabulary([...suite.turns, ...toolTurns, ...suite.failureCases])),
    ...(suite.toolTurn ? await checkToolTurnShape(suite.toolTurn) : []),
    ...(await checkSessionIdReported([...suite.turns, ...toolTurns])),
  ];
}
