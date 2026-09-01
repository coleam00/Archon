import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, rm, readFile, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Inline mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import {
  logWorkflowEvent,
  logWorkflowStart,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
  logNodeComplete,
  logNodeError,
  logWatchdogReset,
  type WorkflowEvent,
} from './logger';

describe('Workflow Logger', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function readLogFile(workflowRunId: string): Promise<WorkflowEvent[]> {
    const logPath = join(testDir, `${workflowRunId}.jsonl`);
    const content = await readFile(logPath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as WorkflowEvent);
  }

  describe('logWorkflowEvent', () => {
    it('should create log file and append event', async () => {
      await logWorkflowEvent(testDir, 'test-run-1', {
        type: 'workflow_start',
        workflow_name: 'test-workflow',
      });

      const events = await readLogFile('test-run-1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow_start');
      expect(events[0].workflow_id).toBe('test-run-1');
      expect(events[0].workflow_name).toBe('test-workflow');
      expect(events[0].ts).toBeDefined();
    });

    it('should append multiple events to same file', async () => {
      await logWorkflowEvent(testDir, 'test-run-2', {
        type: 'workflow_start',
        workflow_name: 'multi-event',
      });
      await logWorkflowEvent(testDir, 'test-run-2', {
        type: 'assistant',
        content: 'Working on it...',
      });
      await logWorkflowEvent(testDir, 'test-run-2', {
        type: 'workflow_complete',
      });

      const events = await readLogFile('test-run-2');
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('workflow_start');
      expect(events[1].type).toBe('assistant');
      expect(events[2].type).toBe('workflow_complete');
    });

    it('should include timestamp in ISO format', async () => {
      const before = new Date().toISOString();
      await logWorkflowEvent(testDir, 'test-run-ts', {
        type: 'workflow_start',
      });
      const after = new Date().toISOString();

      const events = await readLogFile('test-run-ts');
      expect(events[0].ts >= before).toBe(true);
      expect(events[0].ts <= after).toBe(true);
    });

    it('should create logs directory if it does not exist', async () => {
      // testDir has no .archon/logs yet
      await logWorkflowEvent(testDir, 'new-dir-test', {
        type: 'workflow_start',
      });

      const events = await readLogFile('new-dir-test');
      expect(events).toHaveLength(1);
    });
  });

  describe('logWatchdogReset', () => {
    it('persists the reset timestamp and chunk type without chunk content', async () => {
      const resetAt = Date.parse('2026-08-31T20:31:53.123Z');

      await logWatchdogReset(testDir, 'watchdog-test', 'review', 'thinking', resetAt);

      const events = await readLogFile('watchdog-test');
      expect(events).toEqual([
        expect.objectContaining({
          type: 'watchdog_reset',
          workflow_id: 'watchdog-test',
          step: 'review',
          chunk_type: 'thinking',
          ts: '2026-08-31T20:31:53.123Z',
        }),
      ]);
      expect(events[0].content).toBeUndefined();
    });
  });

  describe('logWorkflowStart', () => {
    it('should log workflow start with name and user message', async () => {
      await logWorkflowStart(testDir, 'start-test', 'my-workflow', 'User wants to build feature X');

      const events = await readLogFile('start-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow_start');
      expect(events[0].workflow_name).toBe('my-workflow');
      expect(events[0].content).toBe('User wants to build feature X');
    });
  });

  describe('logNodeComplete', () => {
    it('preserves gross input and reported cache counters', async () => {
      await logNodeComplete(testDir, 'cache-test', 'step1', 'implement', {
        tokens: { input: 120, output: 10, cacheRead: 80, cacheWrite: 0 },
      });

      const events = await readLogFile('cache-test');
      expect(events[0].tokens).toEqual({
        input: 120,
        output: 10,
        cacheRead: 80,
        cacheWrite: 0,
      });
    });

    it('records the reported cost alongside the tokens', async () => {
      await logNodeComplete(testDir, 'cost-test', 'step1', 'implement', {
        durationMs: 1200,
        tokens: { input: 120, output: 10 },
        cost_usd: 0.0042,
      });

      const events = await readLogFile('cost-test');
      expect(events[0].cost_usd).toBe(0.0042);
      expect(events[0].duration_ms).toBe(1200);
      expect(events[0].tokens).toEqual({ input: 120, output: 10 });
    });

    it('keeps a reported zero cost distinct from an unreported one', async () => {
      // Codex reports no cost at all (#2334), so the absent key has to mean exactly
      // that. A provider that reports 0 spent nothing, and must still say so.
      await logNodeComplete(testDir, 'zero-cost', 'step1', 'implement', { cost_usd: 0 });
      await logNodeComplete(testDir, 'no-cost', 'step1', 'implement', {
        tokens: { input: 5, output: 1 },
      });

      const [zero] = await readLogFile('zero-cost');
      const [absent] = await readLogFile('no-cost');
      expect(zero.cost_usd).toBe(0);
      expect('cost_usd' in absent).toBe(false);
    });
  });

  describe('logNodeError', () => {
    it('records what the node spent before it failed', async () => {
      await logNodeError(testDir, 'fail-cost', 'step1', 'provider stream died', {
        tokens: { input: 120, output: 10, cacheRead: 80, cacheWrite: 0 },
        cost_usd: 0.02,
      });

      const [event] = await readLogFile('fail-cost');
      expect(event.type).toBe('node_error');
      expect(event.error).toBe('provider stream died');
      expect(event.cost_usd).toBe(0.02);
      expect(event.tokens).toEqual({ input: 120, output: 10, cacheRead: 80, cacheWrite: 0 });
    });

    it('keeps a reported zero cost distinct from an unreported one', async () => {
      // Same distinction the completion row protects: Codex reports no cost at all
      // (#2334), so an absent key must not be readable as "spent nothing".
      await logNodeError(testDir, 'fail-zero', 'step1', 'boom', { cost_usd: 0 });
      await logNodeError(testDir, 'fail-unreported', 'step1', 'boom', {
        tokens: { input: 5, output: 1 },
      });

      const [zero] = await readLogFile('fail-zero');
      const [absent] = await readLogFile('fail-unreported');
      expect(zero.cost_usd).toBe(0);
      expect('cost_usd' in absent).toBe(false);
    });

    it('writes no usage keys for a failure that could not have spent anything', async () => {
      // A missing command file, a substitution error, a bash exit code: these fail
      // before any provider call, and their callers pass nothing.
      await logNodeError(testDir, 'fail-bare', 'step1', 'command file not found');

      const [event] = await readLogFile('fail-bare');
      expect(event.error).toBe('command file not found');
      expect('cost_usd' in event).toBe(false);
      expect('tokens' in event).toBe(false);
    });
  });

  describe('logAssistant', () => {
    it('should log assistant message content', async () => {
      await logAssistant(testDir, 'assistant-test', 'Here is my response to your request.');

      const events = await readLogFile('assistant-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].content).toBe('Here is my response to your request.');
    });

    it('should handle multi-line content', async () => {
      const multiLineContent = `Line 1
Line 2
Line 3`;
      await logAssistant(testDir, 'multiline-test', multiLineContent);

      const events = await readLogFile('multiline-test');
      expect(events[0].content).toBe(multiLineContent);
    });
  });

  describe('logTool', () => {
    it('should log tool call with name and input', async () => {
      await logTool(testDir, 'tool-test', 'Read', { file_path: '/src/index.ts' });

      const events = await readLogFile('tool-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool');
      expect(events[0].tool_name).toBe('Read');
      expect(events[0].tool_input).toEqual({ file_path: '/src/index.ts' });
    });

    it('should handle complex tool input', async () => {
      const complexInput = {
        command: 'npm test',
        timeout: 30000,
        env: { NODE_ENV: 'test' },
      };
      await logTool(testDir, 'complex-tool-test', 'Bash', complexInput);

      const events = await readLogFile('complex-tool-test');
      expect(events[0].tool_input).toEqual(complexInput);
    });
  });

  describe('logWorkflowError', () => {
    it('should log error message', async () => {
      await logWorkflowError(testDir, 'error-test', 'Step prompt not found: missing-step.md');

      const events = await readLogFile('error-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow_error');
      expect(events[0].error).toBe('Step prompt not found: missing-step.md');
    });

    it('records aggregate run usage when supplied', async () => {
      await logWorkflowError(testDir, 'error-usage', 'Node failed', {
        cost_usd: 0.08,
        tokens: { input: 1200, output: 80, cacheRead: 900, cacheWrite: 0 },
      });

      const [event] = await readLogFile('error-usage');
      expect(event.cost_usd).toBe(0.08);
      expect(event.tokens).toEqual({ input: 1200, output: 80, cacheRead: 900, cacheWrite: 0 });
    });

    it('omits aggregate usage axes when they were not reported', async () => {
      await logWorkflowError(testDir, 'error-no-usage', 'Node failed');

      const [event] = await readLogFile('error-no-usage');
      expect('cost_usd' in event).toBe(false);
      expect('tokens' in event).toBe(false);
    });
  });

  describe('logWorkflowComplete', () => {
    it('should log workflow completion', async () => {
      await logWorkflowComplete(testDir, 'complete-test');

      const events = await readLogFile('complete-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow_complete');
      // A run with no AI usage carries no usage keys at all.
      expect('cost_usd' in events[0]).toBe(false);
      expect('tokens' in events[0]).toBe(false);
    });

    it('records what the whole run spent', async () => {
      await logWorkflowComplete(testDir, 'complete-usage-test', {
        cost_usd: 0.19,
        tokens: { input: 900, output: 120, cacheRead: 400 },
      });

      const events = await readLogFile('complete-usage-test');
      expect(events[0].cost_usd).toBe(0.19);
      expect(events[0].tokens).toEqual({ input: 900, output: 120, cacheRead: 400 });
    });
  });

  describe('full workflow logging scenario', () => {
    it('should log complete workflow execution', async () => {
      const runId = 'full-workflow-test';

      // Simulate a complete DAG workflow
      await logWorkflowStart(testDir, runId, 'feature-dev', 'Add dark mode');
      await logAssistant(testDir, runId, 'I will create a plan for dark mode...');
      await logTool(testDir, runId, 'Write', { file_path: '/plan.md' });
      await logAssistant(testDir, runId, 'Implementing dark mode...');
      await logTool(testDir, runId, 'Edit', { file_path: '/src/theme.ts' });
      await logWorkflowComplete(testDir, runId);

      const events = await readLogFile(runId);
      expect(events).toHaveLength(6);

      // Verify event types in order
      expect(events.map(e => e.type)).toEqual([
        'workflow_start',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'workflow_complete',
      ]);

      // Verify all events have same workflow_id
      expect(events.every(e => e.workflow_id === runId)).toBe(true);
    });

    it('should log workflow with error', async () => {
      const runId = 'error-workflow-test';

      await logWorkflowStart(testDir, runId, 'buggy-workflow', 'Do something');
      await logWorkflowError(testDir, runId, 'Node failed: timeout exceeded');

      const events = await readLogFile(runId);
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe('workflow_error');
      expect(events[1].error).toBe('Node failed: timeout exceeded');
    });
  });

  describe('filesystem error handling', () => {
    it('should not throw when log directory is not writable', async () => {
      // Make testDir read-only (can't write files)
      await chmod(testDir, 0o444);

      try {
        // Should not throw - logging shouldn't break workflow
        await expect(
          logWorkflowEvent(testDir, 'readonly-test', {
            type: 'workflow_start',
            workflow_name: 'test',
          })
        ).resolves.toBeUndefined();
      } finally {
        // Restore permissions for cleanup
        await chmod(testDir, 0o755);
      }
    });

    it('should not throw when logDir does not exist', async () => {
      const nonExistentDir = join(testDir, 'does-not-exist', 'nested');

      // Make parent read-only so mkdir fails
      await mkdir(join(testDir, 'does-not-exist'));
      await chmod(join(testDir, 'does-not-exist'), 0o444);

      try {
        // Should not throw even when directory creation fails
        await expect(
          logWorkflowEvent(nonExistentDir, 'nonexistent-test', {
            type: 'workflow_start',
            workflow_name: 'test',
          })
        ).resolves.toBeUndefined();
      } finally {
        // Restore permissions for cleanup
        await chmod(join(testDir, 'does-not-exist'), 0o755);
      }
    });
  });
});
