// @archon-test-isolated
import { describe, test, expect, mock } from 'bun:test';
import { HeadlessPlatform } from './headless-platform';
import type { WorkflowMessageMetadata } from '@archon/workflows/deps';

describe('HeadlessPlatform', () => {
  test('origin-free delivery needs no recorder', async () => {
    const platform = new HeadlessPlatform();
    expect(platform.getPlatformType()).toBe('api');
    expect(platform.getStreamingMode()).toBe('batch');
    await expect(platform.sendMessage('run-1', 'hello')).resolves.toBeUndefined();
  });

  test('passes messages and metadata to the supplied recorder', async () => {
    const recorder = mock(async (_message: string, _metadata?: WorkflowMessageMetadata) => {});
    const platform = new HeadlessPlatform(recorder, {
      formatWorkflowCommand: command => `archon workflow ${command}`,
    });
    const metadata: WorkflowMessageMetadata = { category: 'workflow_status', segment: 'new' };
    await platform.sendMessage('correlation', 'hello', metadata);
    expect(recorder).toHaveBeenCalledWith('hello', metadata);
    expect(platform.formatWorkflowCommand('resume id')).toBe('archon workflow resume id');
  });

  // A recorder writes real conversation history, so a failed write is a failed delivery
  // for the workflow's delivery boundary to report, not a success.
  test('rejects when the recorder fails', async () => {
    const platform = new HeadlessPlatform(async () => {
      throw new Error('history unavailable');
    });
    await expect(platform.sendMessage('run-1', 'hello')).rejects.toThrow('history unavailable');
  });
});
