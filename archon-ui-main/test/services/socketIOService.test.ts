import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { io, Socket } from 'socket.io-client'

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    connected: true,
    id: 'test-socket-id'
  }))
}))

describe('socketIOService - Shared Instance Pattern', () => {
  let socketIOService: any
  let knowledgeSocketIO: any
  let taskUpdateSocketIO: any
  let projectListSocketIO: any

  beforeEach(async () => {
    // Reset all mocks
    vi.resetAllMocks()
    vi.resetModules()
    
    // Import fresh instances
    const module = await import('../../src/services/socketIOService')
    socketIOService = module
    knowledgeSocketIO = module.knowledgeSocketIO
    taskUpdateSocketIO = module.taskUpdateSocketIO
    projectListSocketIO = module.projectListSocketIO
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('creates only a single shared socket instance', () => {
    // All exported instances should be the same object
    expect(knowledgeSocketIO).toBe(taskUpdateSocketIO)
    expect(taskUpdateSocketIO).toBe(projectListSocketIO)
    expect(knowledgeSocketIO).toBe(projectListSocketIO)
  })

  test('socket.io is called only once despite multiple exports', () => {
    // The io function should only be called once to create the shared instance
    expect(io).toHaveBeenCalledTimes(1)
  })

  test('all services share the same socket connection', () => {
    // Get the internal socket from each service
    const knowledgeSocket = knowledgeSocketIO.socket
    const taskSocket = taskUpdateSocketIO.socket
    const projectSocket = projectListSocketIO.socket

    // All should reference the same socket instance
    expect(knowledgeSocket).toBe(taskSocket)
    expect(taskSocket).toBe(projectSocket)
  })

  test('operations from different services use the same socket', () => {
    const mockCallback = vi.fn()
    
    // Subscribe to events from different service exports
    knowledgeSocketIO.on('knowledge_update', mockCallback)
    taskUpdateSocketIO.on('task_update', mockCallback)
    projectListSocketIO.on('project_update', mockCallback)

    // All operations should use the same underlying socket
    const socket = knowledgeSocketIO.socket
    expect(socket.on).toHaveBeenCalledWith('knowledge_update', expect.any(Function))
    expect(socket.on).toHaveBeenCalledWith('task_update', expect.any(Function))
    expect(socket.on).toHaveBeenCalledWith('project_update', expect.any(Function))
  })

  test('disconnecting one service disconnects all', () => {
    // Disconnect using one service
    knowledgeSocketIO.disconnect()

    // Check that the shared socket was disconnected
    const socket = knowledgeSocketIO.socket
    expect(socket.disconnect).toHaveBeenCalledTimes(1)

    // Verify all services report as disconnected
    expect(knowledgeSocketIO.isConnected()).toBe(false)
    expect(taskUpdateSocketIO.isConnected()).toBe(false)
    expect(projectListSocketIO.isConnected()).toBe(false)
  })

  test('operation tracking is shared across all service exports', () => {
    // Add operation from one service
    const operationId = 'test-op-123'
    knowledgeSocketIO.addOperation(operationId)

    // Check if operation is tracked in all services
    expect(knowledgeSocketIO.isOwnOperation(operationId)).toBe(true)
    expect(taskUpdateSocketIO.isOwnOperation(operationId)).toBe(true)
    expect(projectListSocketIO.isOwnOperation(operationId)).toBe(true)
  })

  test('removing operation from one service removes from all', () => {
    const operationId = 'test-op-456'
    
    // Add operation
    taskUpdateSocketIO.addOperation(operationId)
    expect(knowledgeSocketIO.isOwnOperation(operationId)).toBe(true)
    
    // Remove operation using different service
    projectListSocketIO.removeOperation(operationId)
    
    // Verify removed from all
    expect(knowledgeSocketIO.isOwnOperation(operationId)).toBe(false)
    expect(taskUpdateSocketIO.isOwnOperation(operationId)).toBe(false)
    expect(projectListSocketIO.isOwnOperation(operationId)).toBe(false)
  })

  test('echo suppression works across all service exports', () => {
    const operationId = 'echo-test-789'
    const callback = vi.fn()
    
    // Subscribe to event
    knowledgeSocketIO.on('test_event', callback, true) // skipOwnOperations = true
    
    // Add operation from different service export
    taskUpdateSocketIO.addOperation(operationId)
    
    // Simulate event with operation ID
    const eventData = { operationId, data: 'test' }
    const handler = knowledgeSocketIO.socket.on.mock.calls[0][1]
    handler(eventData)
    
    // Callback should not be called due to echo suppression
    expect(callback).not.toHaveBeenCalled()
    
    // Simulate event without operation ID
    const externalEvent = { data: 'external' }
    handler(externalEvent)
    
    // Callback should be called for external events
    expect(callback).toHaveBeenCalledWith(externalEvent)
  })

  test('connection state is synchronized across all exports', () => {
    const mockSocket = knowledgeSocketIO.socket
    
    // Simulate connected state
    mockSocket.connected = true
    expect(knowledgeSocketIO.isConnected()).toBe(true)
    expect(taskUpdateSocketIO.isConnected()).toBe(true)
    expect(projectListSocketIO.isConnected()).toBe(true)
    
    // Simulate disconnected state
    mockSocket.connected = false
    expect(knowledgeSocketIO.isConnected()).toBe(false)
    expect(taskUpdateSocketIO.isConnected()).toBe(false)
    expect(projectListSocketIO.isConnected()).toBe(false)
  })

  test('emitting from any service uses the shared socket', () => {
    const mockSocket = knowledgeSocketIO.socket
    
    // Emit from different services
    knowledgeSocketIO.emit('event1', { data: 1 })
    taskUpdateSocketIO.emit('event2', { data: 2 })
    projectListSocketIO.emit('event3', { data: 3 })
    
    // All should use the same socket
    expect(mockSocket.emit).toHaveBeenCalledTimes(3)
    expect(mockSocket.emit).toHaveBeenCalledWith('event1', { data: 1 }, undefined)
    expect(mockSocket.emit).toHaveBeenCalledWith('event2', { data: 2 }, undefined)
    expect(mockSocket.emit).toHaveBeenCalledWith('event3', { data: 3 }, undefined)
  })

  test('prevents multiple socket connections when switching tabs', () => {
    // Simulate tab switching by importing the module multiple times
    // In a real scenario, this would happen when components unmount/remount
    
    // First "tab"
    const socket1 = knowledgeSocketIO.socket
    
    // Simulate switching tabs (in reality, components would remount)
    // But the shared instance pattern prevents new connections
    const socket2 = taskUpdateSocketIO.socket
    const socket3 = projectListSocketIO.socket
    
    // All should be the same instance
    expect(socket1).toBe(socket2)
    expect(socket2).toBe(socket3)
    
    // io should still only be called once
    expect(io).toHaveBeenCalledTimes(1)
  })
})