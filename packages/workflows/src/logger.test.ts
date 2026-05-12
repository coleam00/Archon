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
  logValidation,
  logWorkflowError,
  logWorkflowComplete,
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

  describe('logValidation', () => {
    it('should log validation event with check/result', async () => {
      await logValidation(testDir, 'validation-test', {
        check: 'type-check',
        result: 'fail',
        error: 'tsc not found',
      });

      const events = await readLogFile('validation-test');
      expect(events[0].type).toBe('validation');
      expect(events[0].check).toBe('type-check');
      expect(events[0].result).toBe('fail');
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
  });

  describe('logWorkflowComplete', () => {
    it('should log workflow completion', async () => {
      await logWorkflowComplete(testDir, 'complete-test');

      const events = await readLogFile('complete-test');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow_complete');
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
