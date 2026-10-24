import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, readFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { DagNode } from '../../schemas';
import { executeDagWorkflow } from '../../dag-executor';
import type { IWorkflowStore } from '../../store';
import type { IWorkflowPlatform, WorkflowDeps } from '../../deps';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
} from '../test-utils';

export function registerDeterministicTests() {
  describe('executeDagWorkflow -- retry on deterministic (bash/script) nodes (#2088)', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-det-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await mkdir(testDir, { recursive: true });

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
      await removeTempTree(testDir);
    });

    // Deterministic nodes run real subprocesses, so a side-effect counter file is
    // the most direct way to observe how many attempts actually happened.
    async function runNodes(
      nodes: DagNode[]
    ): Promise<{ mockDeps: WorkflowDeps; platform: IWorkflowPlatform }> {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('det-retry-run', {
        workflow_name: 'det-retry',
        conversation_id: 'conv-det-retry',
        user_message: 'det retry message',
      });
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-det-retry',
          cwd: testDir,
          workflow: { name: 'det-retry', nodes },
          workflowRun,
        })
      );
      return { mockDeps, platform };
    }

    it('bash node with retry re-runs until it succeeds', async () => {
      // Forward-slashed for safe embedding in inline bash AND JS string literals
      // (Windows join() yields backslashes; '\a' is an escape in JS strings).
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const marker = join(testDir, 'marker');
      const nodes: DagNode[] = [
        {
          id: 'flaky',
          // Attempt 1: no marker → create it, fail. Attempt 2: marker present → succeed.
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; if [ -e '${marker}' ]; then echo ok; else printf x > '${marker}'; echo 'boom' >&2; exit 1; fi`,
          retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
        },
      ];
      const { mockDeps } = await runNodes(nodes);

      const content = await readFile(attempts, 'utf8');
      // One failing attempt then one succeeding attempt → exactly 2 runs.
      expect(content.length).toBe(2);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
    });

    it('bash node with retry exhausts all attempts on persistent failure', async () => {
      // Forward-slashed for safe embedding in inline bash AND JS string literals
      // (Windows join() yields backslashes; '\a' is an escape in JS strings).
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const nodes: DagNode[] = [
        {
          id: 'always-fails',
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
          retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
        },
      ];
      const { mockDeps } = await runNodes(nodes);

      const content = await readFile(attempts, 'utf8');
      // max_attempts: 2 = 2 retries → 3 total attempts. Without the fix this is 1.
      expect(content.length).toBe(3);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
    });

    it('bash node WITHOUT a retry block runs exactly once (single-attempt default preserved)', async () => {
      // Forward-slashed for safe embedding in inline bash AND JS string literals
      // (Windows join() yields backslashes; '\a' is an escape in JS strings).
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const nodes: DagNode[] = [
        {
          id: 'no-retry',
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
        },
      ];
      const { mockDeps } = await runNodes(nodes);

      const content = await readFile(attempts, 'utf8');
      // Deterministic nodes never auto-retry — retry is opt-in via an explicit block.
      expect(content.length).toBe(1);
      expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
    });

    it('bash node whose stderr says "timeout" is not retried under the default on_error', async () => {
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const nodes: DagNode[] = [
        {
          id: 'curl',
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; echo 'curl: (28) connection timeout' >&2; exit 1`,
          retry: { max_attempts: 2, delay_ms: 1 },
        },
      ];
      await runNodes(nodes);

      // A non-zero exit is exec_failed, retried only under on_error: all. The script's
      // own output is not evidence, whatever it says.
      expect((await readFile(attempts, 'utf8')).length).toBe(1);
    });

    it('bash node is retried under on_error: all whatever its stderr says', async () => {
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const nodes: DagNode[] = [
        {
          id: 'unauthorized',
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; echo '401 unauthorized' >&2; exit 1`,
          retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
        },
      ];
      await runNodes(nodes);

      expect((await readFile(attempts, 'utf8')).length).toBe(3);
    });

    it(
      'bash node that times out is retried as transient',
      async () => {
        const { mockDeps } = await runNodes([
          {
            id: 'slow',
            kind: 'exec',
            runtime: 'sh',
            script: 'sleep 5',
            timeout: 100,
            retry: { max_attempts: 1, delay_ms: 1 },
          },
        ]);

        // Count the engine's per-attempt rows rather than a side-effect file: on a loaded
        // runner the 100 ms timeout can fire before the shell writes anything.
        const timedOut = (
          mockDeps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
        ).mock.calls.filter(
          ([event]) => event.event_type === 'node_failed' && event.data?.failure_kind === 'timeout'
        );
        expect(timedOut).toHaveLength(2);
      },
      testTimeout(10_000)
    );

    it(
      'script node that times out is retried as transient',
      async () => {
        const { mockDeps } = await runNodes([
          {
            id: 'slow-script',
            kind: 'exec',
            runtime: 'bun',
            script: 'setTimeout(() => {}, 30000)',
            timeout: 100,
            retry: { max_attempts: 1, delay_ms: 1 },
          },
        ]);

        // Count the engine's per-attempt rows rather than a side-effect file: a slow
        // runtime start can hit the 100 ms timeout before the script writes anything.
        const timedOut = (
          mockDeps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
        ).mock.calls.filter(
          ([event]) => event.event_type === 'node_failed' && event.data?.failure_kind === 'timeout'
        );
        expect(timedOut).toHaveLength(2);
      },
      testTimeout(10_000)
    );

    it(
      'script node with retry re-runs on persistent failure',
      async () => {
        // Forward-slashed for safe embedding in inline bash AND JS string literals
        // (Windows join() yields backslashes; '\a' is an escape in JS strings).
        const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
        const nodes: DagNode[] = [
          {
            id: 'flaky-script',
            kind: 'exec',
            script: `require('fs').appendFileSync('${attempts}', 'a'); process.exit(1)`,
            runtime: 'bun',
            retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
          },
        ];
        const { mockDeps } = await runNodes(nodes);

        const content = await readFile(attempts, 'utf8');
        // 1 initial + 2 retries = 3. Without the fix this is 1.
        expect(content.length).toBe(3);
        expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
      },
      testTimeout(10_000)
    );

    it('bash retry sends a platform notification before each retry', async () => {
      // Forward-slashed for safe embedding in inline bash AND JS string literals
      // (Windows join() yields backslashes; '\a' is an escape in JS strings).
      const attempts = join(testDir, 'attempts.log').replace(/\\/g, '/');
      const nodes: DagNode[] = [
        {
          id: 'notify',
          kind: 'exec',
          runtime: 'sh',
          script: `printf 'a' >> '${attempts}'; echo 'boom' >&2; exit 1`,
          retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' },
        },
      ];
      const { platform } = await runNodes(nodes);

      const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const retryMessages = sendCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Retrying in')
      );
      // 2 retries → 2 retry notifications.
      expect(retryMessages.length).toBe(2);
    });
  });
}
