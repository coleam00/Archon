import { subtaskTerminalStatusSchema, type ProviderEvent } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { IWorkflowStore } from './store';
import type { ToolCallAttention } from './schemas/workflow-run';

interface ToolCallAttentionOptions {
  store: Pick<IWorkflowStore, 'setToolCallAttention'>;
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
  const tools = new Map<string, Omit<ToolCallAttention, 'raisedAt'> & { raisedAt?: string }>();
  const subtasks = new Map<string, Omit<ToolCallAttention, 'raisedAt'> & { raisedAt?: string }>();
  const parents = new Map<string, string>();
  let persisted = '[]';

  async function persist(): Promise<boolean> {
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
    const snapshot = JSON.stringify(calls);
    if (snapshot === persisted) return true;
    try {
      const changed = await options.store.setToolCallAttention(options.runId, streamId, calls);
      if (changed || calls.length === 0) {
        persisted = snapshot;
        return true;
      }
    } catch {
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

  return {
    hasOpenTools: () => tools.size > 0,
    async observe(event: ProviderEvent): Promise<void> {
      if (event.type === 'tool_call' && !tools.has(event.toolCallId)) {
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
      } else if (event.type === 'tool_call_update') {
        tools.delete(event.toolCallId);
      } else if (event.type === 'subtask') {
        if (event.parentToolCallId) parents.set(event.taskId, event.parentToolCallId);
        const parent = parents.get(event.taskId);
        const tool = parent ? tools.get(parent) : undefined;
        if (tool) {
          tool.lastProgressAt = new Date(now()).toISOString();
          delete tool.raisedAt;
        }
        if (options.reportedBackgroundWork) {
          if (terminalSubtasks.has(event.status)) subtasks.delete(event.taskId);
          else {
            const at = new Date(now()).toISOString();
            const task = subtasks.get(event.taskId);
            if (task) {
              if (event.status === 'running') {
                task.lastProgressAt = at;
                delete task.raisedAt;
              }
            } else {
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
            }
          }
        }
      }
      await refresh();
    },
    refresh,
    async clear(): Promise<void> {
      tools.clear();
      subtasks.clear();
      parents.clear();
      if (!(await persist())) retainCleanup(persist);
    },
  };
}
