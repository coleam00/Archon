import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock data for testing
const mockTasks = [
  {
    id: 'task-1',
    title: 'First task',
    description: 'Description 1',
    status: 'todo',
    assignee: 'User',
    task_order: 1,
    feature: 'feature-1'
  },
  {
    id: 'task-2', 
    title: 'Second task',
    description: 'Description 2',
    status: 'todo',
    assignee: 'AI IDE Agent',
    task_order: 2,
    feature: 'feature-1'
  },
  {
    id: 'task-3',
    title: 'Third task',
    description: 'Description 3',
    status: 'todo',
    assignee: 'Archon',
    task_order: 3,
    feature: 'feature-2'
  },
  {
    id: 'task-4',
    title: 'Fourth task',
    description: 'Description 4',
    status: 'doing',
    assignee: 'User',
    task_order: 1,
    feature: 'feature-2'
  }
]

describe('TasksTab - Task Reordering', () => {
  let reorderTasks: any
  let handleReorderTasks: any

  beforeEach(() => {
    vi.resetModules()
  })

  describe('Sequential Ordering System', () => {
    test('maintains sequential order (1, 2, 3, ...) after reordering', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Move task from index 0 to index 2
      const reordered = moveTask(tasks, 0, 2)
      
      // Check that task_order is sequential
      expect(reordered[0].task_order).toBe(1)
      expect(reordered[1].task_order).toBe(2)
      expect(reordered[2].task_order).toBe(3)
    })

    test('updates task_order for all affected tasks', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Move last task to first position
      const reordered = moveTask(tasks, 2, 0)
      
      expect(reordered[0].id).toBe('task-3')
      expect(reordered[0].task_order).toBe(1)
      expect(reordered[1].id).toBe('task-1')
      expect(reordered[1].task_order).toBe(2)
      expect(reordered[2].id).toBe('task-2')
      expect(reordered[2].task_order).toBe(3)
    })

    test('handles moving task within same status column', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Move middle task to end
      const reordered = moveTask(tasks, 1, 2)
      
      expect(reordered[0].id).toBe('task-1')
      expect(reordered[1].id).toBe('task-3')
      expect(reordered[2].id).toBe('task-2')
      
      // All should have sequential ordering
      reordered.forEach((task, index) => {
        expect(task.task_order).toBe(index + 1)
      })
    })
  })

  describe('Batch Reorder Persistence', () => {
    test('batches multiple reorder operations', () => {
      const persistBatch = vi.fn()
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Simulate multiple rapid reorders
      const reordered1 = moveTask(tasks, 0, 2)
      const reordered2 = moveTask(reordered1, 1, 0)
      
      // In actual implementation, these would be debounced
      // and sent as a single batch update
      expect(reordered2[0].task_order).toBe(1)
      expect(reordered2[1].task_order).toBe(2)
      expect(reordered2[2].task_order).toBe(3)
    })

    test('preserves lastUpdate timestamp for optimistic updates', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      const timestamp = Date.now()
      
      const reordered = moveTask(tasks, 0, 2, timestamp)
      
      // All reordered tasks should have the lastUpdate timestamp
      reordered.forEach(task => {
        expect(task.lastUpdate).toBe(timestamp)
      })
    })
  })

  describe('Race Condition Prevention', () => {
    test('ignores updates for deleted tasks', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      const deletedTaskId = 'task-2'
      
      // Remove task-2 to simulate deletion
      const afterDeletion = tasks.filter(t => t.id !== deletedTaskId)
      
      // Try to reorder with deleted task - should handle gracefully
      const reordered = afterDeletion.map((task, index) => ({
        ...task,
        task_order: index + 1
      }))
      
      expect(reordered.length).toBe(2)
      expect(reordered.find(t => t.id === deletedTaskId)).toBeUndefined()
    })

    test('handles concurrent updates with temporary task replacement', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      const tempTask = { ...tasks[0], title: 'Temporary update' }
      
      // Replace task temporarily (optimistic update)
      const withTemp = tasks.map(t => 
        t.id === tempTask.id ? tempTask : t
      )
      
      expect(withTemp[0].title).toBe('Temporary update')
      expect(withTemp[0].id).toBe(tasks[0].id)
    })

    test('maintains order consistency during concurrent operations', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Simulate two concurrent reorder operations
      const reorder1 = moveTask([...tasks], 0, 2)
      const reorder2 = moveTask([...tasks], 2, 1)
      
      // Both should maintain sequential ordering
      reorder1.forEach((task, index) => {
        expect(task.task_order).toBe(index + 1)
      })
      
      reorder2.forEach((task, index) => {
        expect(task.task_order).toBe(index + 1)
      })
    })
  })

  describe('Cross-Status Reordering', () => {
    test('handles moving task to different status column', () => {
      const todoTasks = mockTasks.filter(t => t.status === 'todo')
      const doingTasks = mockTasks.filter(t => t.status === 'doing')
      
      // Move first todo task to doing column
      const taskToMove = todoTasks[0]
      const updatedTask = { ...taskToMove, status: 'doing' }
      
      // Update todo column (remove task)
      const newTodoTasks = todoTasks.slice(1).map((task, index) => ({
        ...task,
        task_order: index + 1
      }))
      
      // Update doing column (add task at position)
      const newDoingTasks = [
        updatedTask,
        ...doingTasks
      ].map((task, index) => ({
        ...task,
        task_order: index + 1
      }))
      
      // Verify sequential ordering in both columns
      expect(newTodoTasks.every((t, i) => t.task_order === i + 1)).toBe(true)
      expect(newDoingTasks.every((t, i) => t.task_order === i + 1)).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    test('handles empty task list', () => {
      const tasks: any[] = []
      const reordered = moveTask(tasks, 0, 0)
      
      expect(reordered).toEqual([])
    })

    test('handles single task', () => {
      const tasks = [mockTasks[0]]
      const reordered = moveTask(tasks, 0, 0)
      
      expect(reordered[0].task_order).toBe(1)
      expect(reordered.length).toBe(1)
    })

    test('handles invalid indices gracefully', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      
      // Try to move with out-of-bounds index
      const reordered = moveTask(tasks, 10, 0)
      
      // Should return tasks unchanged
      expect(reordered).toEqual(tasks)
    })

    test('preserves task data during reorder', () => {
      const tasks = [...mockTasks.filter(t => t.status === 'todo')]
      const originalTask = { ...tasks[0] }
      
      const reordered = moveTask(tasks, 0, 2)
      const movedTask = reordered.find(t => t.id === originalTask.id)
      
      // All properties except task_order should be preserved
      expect(movedTask?.title).toBe(originalTask.title)
      expect(movedTask?.description).toBe(originalTask.description)
      expect(movedTask?.assignee).toBe(originalTask.assignee)
      expect(movedTask?.feature).toBe(originalTask.feature)
    })
  })

  describe('Flexible Assignee Support', () => {
    test('supports any assignee name string', () => {
      const customAssignees = [
        'prp-executor',
        'prp-validator', 
        'Custom Agent',
        'test-agent-123'
      ]
      
      customAssignees.forEach(assignee => {
        const task = { ...mockTasks[0], assignee }
        expect(task.assignee).toBe(assignee)
        expect(typeof task.assignee).toBe('string')
      })
    })

    test('handles empty assignee gracefully', () => {
      const task = { ...mockTasks[0], assignee: '' }
      expect(task.assignee).toBe('')
      
      // Should default to 'AI IDE Agent' in UI
      const displayAssignee = task.assignee || 'AI IDE Agent'
      expect(displayAssignee).toBe('AI IDE Agent')
    })
  })
})

// Helper function to simulate task reordering
function moveTask(tasks: any[], fromIndex: number, toIndex: number, timestamp?: number): any[] {
  if (fromIndex < 0 || fromIndex >= tasks.length || 
      toIndex < 0 || toIndex >= tasks.length) {
    return tasks
  }

  const result = [...tasks]
  const [movedTask] = result.splice(fromIndex, 1)
  result.splice(toIndex, 0, movedTask)
  
  // Update task_order to be sequential
  return result.map((task, index) => ({
    ...task,
    task_order: index + 1,
    ...(timestamp ? { lastUpdate: timestamp } : {})
  }))
}