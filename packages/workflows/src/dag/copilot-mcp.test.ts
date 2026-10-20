// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CopilotProvider, registerCopilotProvider } from '@archon/providers/community/copilot';
import { executeDagWorkflow } from '../dag-executor';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';

const trackTempRoot = trackTempRoots();
const failedEvent = {
  id: 'failure',
  ephemeral: true,
  timestamp: '2026-10-20T00:00:00Z',
  parentId: null,
  type: 'session.mcp_server_status_changed',
  data: { serverName: 'declared', status: 'failed', error: 'lost connection' },
};
let notify: ((event: typeof failedEvent) => void) | undefined;
const send = mock(async () => ({ data: { content: 'completed despite optional MCP failure' } }));
const disconnect = mock(async () => {});
mock.module('@github/copilot-sdk', () => ({
  approveAll: () => ({ kind: 'approved' }),
  CopilotClient: class {
    async createSession() {
      return {
        sessionId: 'copilot-session',
        rpc: {
          mcp: {
            list: async () => {
              queueMicrotask(() => notify?.(failedEvent));
              return { servers: [{ name: 'declared', status: 'connected' }] };
            },
          },
        },
        on(listener: NonNullable<typeof notify>) {
          notify = listener;
          return () => {
            notify = undefined;
          };
        },
        sendAndWait: send,
        disconnect,
        abort: async () => {},
      };
    }
    async stop() {
      return [];
    }
  },
}));

for (const optional of [true, false]) {
  test(`Copilot startup failure ${optional ? 'warns and completes an optional node' : 'fails a required node before input'}`, async () => {
    registerCopilotProvider();
    const cwd = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-copilot-mcp-')));
    await writeFile(join(cwd, 'mcp.json'), JSON.stringify({ declared: { command: 'fixture' } }));
    send.mockClear();
    disconnect.mockClear();
    const store = createMockStore();
    const deps = createMockDeps(store);
    const provider = new CopilotProvider();
    deps.getAgentProvider = () => ({
      getType: () => provider.getType(),
      getCapabilities: () => provider.getCapabilities(),
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
      sendQuery: provider.sendQuery.bind(provider),
    });
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd,
        platform,
        workflowRun: makeWorkflowRun(),
        workflow: {
          name: 'copilot-mcp',
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              provider: 'copilot',
              source: { kind: 'inline', prompt: 'work' },
              mcp: { path: 'mcp.json', optional },
            },
          ],
        },
      })
    );
    expect(platform.sendMessage.mock.calls.map(call => call[1])).toContain(
      'MCP server connection failed: declared (failed): lost connection'
    );
    expect(send).toHaveBeenCalledTimes(optional ? 1 : 0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(notify).toBeUndefined();
    const events = store.createWorkflowEvent.mock.calls.map(call => call[0]);
    expect(
      events.some(event => event.event_type === (optional ? 'node_completed' : 'node_failed'))
    ).toBe(true);
    expect(
      events.some(event => event.event_type === (optional ? 'node_failed' : 'node_completed'))
    ).toBe(false);
  });
}
