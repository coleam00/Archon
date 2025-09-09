import { describe, it, expect, vi, beforeEach } from 'vitest'
import { taskService } from '../../src/features/projects/tasks/services'
import type { Task } from '../../src/features/projects/tasks/types'
import { ProjectServiceError } from '../../src/features/projects/shared/api'

// Utility to build a minimal valid Task object for tests
function buildTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 't1',
    project_id: 'p1',
    title: 'Test Task',
    description: 'Desc',
    status: 'todo',
    assignee: 'User',
    task_order: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  return { ...base, ...overrides }
}

// Simple Response-like object factory
function mockResponse(body: unknown, init?: { status?: number; ok?: boolean; headers?: Record<string, string> }) {
  const headers = init?.headers ?? {}
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (k: string) => headers[k] ?? null },
  } as unknown as Response
}

describe('taskService - Step 03 (lightweight lists + details)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('getTasksByProject defaults to exclude_large_fields=true and builds the correct URL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce(
      mockResponse([buildTask({ id: 't1' })])
    )

    const tasks = await taskService.getTasksByProject('proj-123')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl = (fetchSpy.mock.calls[0][0] as string)
    expect(calledUrl).toBe('/api/projects/proj-123/tasks?exclude_large_fields=true')

    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks[0].id).toBe('t1')
  })

  it('getTasksByProject allows fetching full payload when excludeLargeFields=false', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce(
      mockResponse([buildTask({ id: 't2' })])
    )

    const tasks = await taskService.getTasksByProject('proj-999', false)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl = (fetchSpy.mock.calls[0][0] as string)
    expect(calledUrl).toBe('/api/projects/proj-999/tasks')
    expect(tasks[0].id).toBe('t2')
  })

  it('getTaskDetails fetches full details via /details endpoint and parses response', async () => {
    const fullTask = buildTask({ id: 'detail-1', description: 'Long text ...' })
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce(
      mockResponse(fullTask)
    )

    const task = await taskService.getTaskDetails('detail-1')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl = (fetchSpy.mock.calls[0][0] as string)
    expect(calledUrl).toBe('/api/tasks/detail-1/details')
    expect(task.id).toBe('detail-1')
    expect(task.description).toBe('Long text ...')
  })

  it('propagates HTTP errors from API client as ProjectServiceError', async () => {
    const errorBody = { detail: 'Boom' }
    vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce(
      mockResponse(errorBody, { ok: false, status: 500 })
    )

    await expect(taskService.getTasksByProject('p-error')).rejects.toBeInstanceOf(ProjectServiceError)
  })
})

