// @archon-test-isolated
import { describe, it, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';

describe('executeDagWorkflow -- break at settled (no hang on subprocess exit)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-break-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    // Restore default sync generator so later tests aren't affected
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  it('command/prompt node completes at settled — does not block on a subprocess that never exits', async () => {
    // Generator settles then hangs forever (simulates subprocess that won't exit)
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'sess-break' };
      yield { type: 'settled' };
      // Subprocess hangs — without break, this blocks until idle timeout
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Should complete promptly (not hang for 30 min)
    // A regression hangs until the test's own budget fails it.
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'break-test',
          nodes: [{ id: 'n1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
      })
    );
  });

  it('loop node completes at settled — does not block on a subprocess that never exits', async () => {
    // Generator settles then hangs forever
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'All done. COMPLETE' };
      yield { type: 'result', sessionId: 'sess-loop-break' };
      yield { type: 'settled' };
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // A regression hangs until the test's own budget fails it.
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-break-test',
          nodes: [
            {
              id: 'loop1',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do the thing. Say COMPLETE when done.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
      })
    );
  });
});
