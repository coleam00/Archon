import { subtaskTerminalStatusSchema, type ProviderEvent } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { IWorkflowStore } from './store';
import {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionArraySchema,
  type ToolCallAttention,
} from './schemas/workflow-run';

interface ToolCallAttentionOptions {
  store: Pick<IWorkflowStore, 'setToolCallAttention' | 'getWorkflowRun'>;
  runId: string;
  nodeId: string;
  provider: string;
  reportedBackgroundWork: boolean;
  thresholdMs: number;
  env: Readonly<Record<string, string | undefined>>;
  protectedEnvKeys?: readonly string[];
  protectedCredentialValues?: readonly string[];
  now?: () => number;
  streamId?: string;
}

/** The stall occurrences currently published by a stream. */
export type StreamStall = Pick<ToolCallAttention, 'streamId' | 'toolCallId' | 'raisedAt'>[];

type SubtaskEvent = Extract<ProviderEvent, { type: 'subtask' }>;

type TrackedCall = Omit<ToolCallAttention, 'raisedAt'> & { raisedAt?: string };

const terminalSubtasks: ReadonlySet<string> = new Set(subtaskTerminalStatusSchema.options);

export function createRunToolCallAttention(
  options: Pick<ToolCallAttentionOptions, 'store' | 'runId'>
): {
  createStream(
    stream: Omit<ToolCallAttentionOptions, 'store' | 'runId'>
  ): ReturnType<typeof createToolCallAttention>;
  refresh(): Promise<void>;
} {
  const pending = new Set<() => Promise<boolean>>();
  return {
    createStream(
      stream: Omit<ToolCallAttentionOptions, 'store' | 'runId'>
    ): ReturnType<typeof createToolCallAttention> {
      return createToolCallAttention({ ...options, ...stream }, retry => pending.add(retry));
    },
    async refresh(): Promise<void> {
      for (const retry of pending) {
        if (await retry()) pending.delete(retry);
      }
    },
  };
}

function createToolCallAttention(
  options: ToolCallAttentionOptions,
  retainCleanup: (retry: () => Promise<boolean>) => void
): {
  hasOpenTools(): boolean;
  /** Current stall identities, while the run row shows them. */
  stall(): StreamStall | undefined;
  observe(event: ProviderEvent): Promise<void>;
  refresh(): Promise<void>;
  clear(): Promise<void>;
} {
  const streamId = options.streamId ?? crypto.randomUUID();
  const now = options.now ?? Date.now;
  const credentials = collectCredentialValues(
    options.env,
    options.protectedEnvKeys,
    options.protectedCredentialValues
  );
  const display = (value: string): string =>
    Array.from(redactCredentialValues(value, credentials)).slice(0, 512).join('');
  const tools = new Map<string, TrackedCall>();
  const subtasks = new Map<string, TrackedCall>();
  const parents = new Map<string, string>();
  let closed = false;
  let persisted: string | undefined = '[]';
  let stall: StreamStall | undefined;

  function stalledCalls(): ToolCallAttention[] {
    if (closed) return [];
    const time = now();
    const calls: ToolCallAttention[] = [];
    const independentSubtasks = [...subtasks]
      .filter(([id]) => {
        const parent = parents.get(id);
        return !parent || !tools.has(parent);
      })
      .map(([, task]) => task);
    if (options.thresholdMs > 0)
      for (const tool of [...tools.values(), ...independentSubtasks]) {
        if (
          tool.raisedAt !== undefined ||
          time - Date.parse(tool.lastProgressAt) >= options.thresholdMs
        ) {
          tool.raisedAt ??= new Date(time).toISOString();
          calls.push({ ...tool, raisedAt: tool.raisedAt });
        }
      }
    return calls;
  }

  async function storedSnapshotMatches(snapshot: string): Promise<boolean> {
    const run = await options.store.getWorkflowRun(options.runId);
    const stored = toolCallAttentionArraySchema.safeParse(
      run?.metadata[TOOL_CALL_ATTENTION_METADATA_KEY]
    );
    return (
      run?.status === 'running' &&
      stored.success &&
      JSON.stringify(stored.data.filter(call => call.streamId === streamId)) === snapshot
    );
  }

  let persistence = Promise.resolve(true);

  function persist(): Promise<boolean> {
    persistence = persistence.then(writeSnapshot);
    return persistence;
  }

  async function writeSnapshot(): Promise<boolean> {
    const calls = stalledCalls();
    stall = undefined;
    const occurrences = calls.map(({ streamId, toolCallId, raisedAt }) => ({
      streamId,
      toolCallId,
      raisedAt,
    }));
    const snapshot = JSON.stringify(toolCallAttentionArraySchema.parse(calls));
    if (snapshot === persisted) {
      stall = occurrences.length === 0 ? undefined : occurrences;
      return true;
    }
    try {
      const changed = await options.store.setToolCallAttention(options.runId, streamId, calls);
      let confirmed = changed || calls.length === 0;
      if (!confirmed) {
        // A lost COMMIT response can reject a write the database already committed.
        confirmed = await storedSnapshotMatches(snapshot);
      }
      if (confirmed) {
        persisted = snapshot;
        stall = occurrences.length === 0 ? undefined : occurrences;
        return true;
      }
    } catch {
      persisted = undefined;
      // Observability must never turn live work into node failure.
      createLogger('workflow.tool-attention').warn(
        { runId: options.runId, nodeId: options.nodeId, streamId, category: 'persistence' },
        'tool_attention.write_failed'
      );
    }
    return false;
  }

  const refresh = async (): Promise<void> => {
    await persist();
  };

  function trackToolCall(event: Extract<ProviderEvent, { type: 'tool_call' }>): void {
    if (tools.has(event.toolCallId)) return;
    const at = new Date(now()).toISOString();
    tools.set(event.toolCallId, {
      streamId,
      nodeId: options.nodeId,
      provider: options.provider,
      toolCallId: event.toolCallId,
      name: display(event.name) || 'tool',
      ...(event.title ? { title: display(event.title) } : {}),
      startedAt: at,
      lastProgressAt: at,
      thresholdMs: options.thresholdMs,
    });
  }

  function observeSubtask(event: SubtaskEvent): void {
    if (event.parentToolCallId) parents.set(event.taskId, event.parentToolCallId);
    markParentToolProgress(event.taskId);
    if (options.reportedBackgroundWork) trackSubtask(event);
  }

  // Any subtask event is progress on the tool call that spawned it.
  function markParentToolProgress(taskId: string): void {
    const parent = parents.get(taskId);
    const tool = parent ? tools.get(parent) : undefined;
    if (!tool) return;
    tool.lastProgressAt = new Date(now()).toISOString();
    delete tool.raisedAt;
  }

  function trackSubtask(event: SubtaskEvent): void {
    if (terminalSubtasks.has(event.status)) {
      subtasks.delete(event.taskId);
      return;
    }
    const at = new Date(now()).toISOString();
    const task = subtasks.get(event.taskId);
    if (!task) {
      subtasks.set(event.taskId, {
        streamId,
        nodeId: options.nodeId,
        provider: options.provider,
        toolCallId: `subtask:${event.taskId}`,
        name: display(event.taskType || 'subtask'),
        ...(event.description ? { title: display(event.description) } : {}),
        startedAt: at,
        lastProgressAt: at,
        thresholdMs: options.thresholdMs,
      });
    } else if (event.status === 'running') {
      task.lastProgressAt = at;
      delete task.raisedAt;
    }
  }

  return {
    hasOpenTools: () => tools.size > 0,
    stall: () => stall,
    async observe(event: ProviderEvent): Promise<void> {
      if (event.type === 'tool_call') trackToolCall(event);
      else if (event.type === 'tool_call_update') tools.delete(event.toolCallId);
      else if (event.type === 'subtask') observeSubtask(event);
      await refresh();
    },
    refresh,
    async clear(): Promise<void> {
      closed = true;
      tools.clear();
      subtasks.clear();
      parents.clear();
      if (!(await persist())) retainCleanup(persist);
    },
  };
}
