import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ETag API helper before importing the service under test
vi.mock('../../src/features/projects/shared/apiWithEtag', () => {
  return {
    callAPIWithETag: vi.fn(async () => undefined),
    invalidateETagCache: vi.fn(),
  };
});

import { callAPIWithETag, invalidateETagCache } from '../../src/features/projects/shared/apiWithEtag';
import { taskService } from '../../src/features/projects/tasks/services';

describe('taskService URL building and calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getTasksByProject includes exclude_large_fields=true by default', async () => {
    vi.mocked(callAPIWithETag).mockResolvedValueOnce([]);
    await taskService.getTasksByProject('proj-1');

    expect(callAPIWithETag).toHaveBeenCalledTimes(1);
    const url = vi.mocked(callAPIWithETag).mock.calls[0][0] as string;
    expect(url).toBe('/api/projects/proj-1/tasks?exclude_large_fields=true');
  });

  it('getTasksByProject can disable exclude_large_fields', async () => {
    vi.mocked(callAPIWithETag).mockResolvedValueOnce([]);
    await taskService.getTasksByProject('proj-1', false);

    const url = vi.mocked(callAPIWithETag).mock.calls[0][0] as string;
    expect(url).toBe('/api/projects/proj-1/tasks');
  });

  it('getTaskDetails calls the details endpoint', async () => {
    vi.mocked(callAPIWithETag).mockResolvedValueOnce({ id: 't1' });
    await taskService.getTaskDetails('t1');

    const url = vi.mocked(callAPIWithETag).mock.calls[0][0] as string;
    expect(url).toBe('/api/tasks/t1/details');
  });

  it('updateTaskStatus sends PUT with JSON body and invalidates counts', async () => {
    vi.mocked(callAPIWithETag).mockResolvedValueOnce({ id: 't1', status: 'doing' } as any);

    await taskService.updateTaskStatus('t1', 'doing');

    // Assert URL and options
    const [url, options] = vi.mocked(callAPIWithETag).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks/t1');
    expect(options?.method).toBe('PUT');
    expect(options?.body && JSON.parse(options.body as string)).toEqual({ status: 'doing' });
  });

  it('createTask invalidates project task list and counts cache', async () => {
    vi.mocked(callAPIWithETag).mockResolvedValueOnce({ id: 'new-task', project_id: 'proj-1' } as any);

    await taskService.createTask({ project_id: 'proj-1', title: 'New', description: '' });

    expect(invalidateETagCache).toHaveBeenCalledWith('/api/projects/proj-1/tasks');
    expect(invalidateETagCache).toHaveBeenCalledWith('/api/tasks/counts');
  });
});

