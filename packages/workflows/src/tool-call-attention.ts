import type { ProviderEvent } from '@archon/provider-contract';
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
  attemptId: string;
  provider: string;
  thresholdMs: number;
  env: Readonly<Record<string, string | undefined>>;
  protectedEnvKeys?: readonly string[];
  protectedCredentialValues?: readonly string[];
  now?: () => number;
  streamId?: string;
}

export function createToolCallAttention(options: ToolCallAttentionOptions): {
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
  const parents = new Map<string, string>();
  let persisted = '[]';

  async function refresh(): Promise<void> {
    const time = now();
    const calls: ToolCallAttention[] = [];
    if (options.thresholdMs > 0)
      for (const tool of tools.values()) {
        if (
          tool.raisedAt !== undefined ||
          time - Date.parse(tool.lastProgressAt) >= options.thresholdMs
        ) {
          tool.raisedAt ??= new Date(time).toISOString();
          calls.push({ ...tool, raisedAt: tool.raisedAt });
        }
      }
    const snapshot = JSON.stringify(calls);
    if (snapshot === persisted) return;
    try {
      if (await options.store.setToolCallAttention(options.runId, streamId, calls))
        persisted = snapshot;
    } catch {
      // Observability must never turn live work into node failure. Retry on the next stream tick.
      createLogger('workflow.tool-attention').warn(
        { runId: options.runId, nodeId: options.nodeId, streamId, category: 'persistence' },
        'tool_attention.write_failed'
      );
    }
  }

  return {
    hasOpenTools: () => tools.size > 0,
    async observe(event: ProviderEvent): Promise<void> {
      if (event.type === 'tool_call' && !tools.has(event.toolCallId)) {
        const at = new Date(now()).toISOString();
        tools.set(event.toolCallId, {
          streamId,
          attemptId: options.attemptId,
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
      }
      await refresh();
    },
    refresh,
    async clear(): Promise<void> {
      tools.clear();
      parents.clear();
      await refresh();
    },
  };
}
