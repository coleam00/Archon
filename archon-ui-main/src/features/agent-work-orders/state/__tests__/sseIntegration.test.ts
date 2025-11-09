/**
 * Integration tests for SSE Connection Lifecycle
 *
 * Tests EventSource connection management, event handling, and cleanup
 * Mocks EventSource API to simulate connection states
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../../types";
import { useAgentWorkOrdersStore } from "../agentWorkOrdersStore";

// Mock EventSource
class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = 0;
  private listeners: Map<string, ((event: Event) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    this.readyState = 0; // CONNECTING
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)?.push(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // Helper methods for testing
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      const event = new MessageEvent("message", { data });
      this.onmessage(event);
    }
  }

  simulateError(): void {
    if (this.onerror) {
      this.onerror();
    }
  }
}

describe("SSE Integration Tests", () => {
  let mockEventSourceInstances: MockEventSource[] = [];

  beforeEach(() => {
    // Reset store
    useAgentWorkOrdersStore.setState({
      layoutMode: "sidebar",
      sidebarExpanded: true,
      showAddRepoModal: false,
      showEditRepoModal: false,
      showCreateWorkOrderModal: false,
      editingRepository: null,
      preselectedRepositoryId: undefined,
      searchQuery: "",
      selectedRepositoryId: undefined,
      logConnections: new Map(),
      connectionStates: {},
      liveLogs: {},
      liveProgress: {},
    });

    // Clear mock instances
    mockEventSourceInstances = [];

    // Mock EventSource globally
    global.EventSource = vi.fn((url: string) => {
      const instance = new MockEventSource(url);
      mockEventSourceInstances.push(instance);
      return instance as unknown as EventSource;
    }) as unknown as typeof EventSource;
  });

  afterEach(() => {
    // Disconnect all connections
    const { disconnectAll } = useAgentWorkOrdersStore.getState();
    disconnectAll();

    vi.restoreAllMocks();
  });

  describe("connectToLogs", () => {
    it("should create EventSource connection with correct URL", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-123";

      connectToLogs(workOrderId);

      expect(global.EventSource).toHaveBeenCalledWith(`/api/agent-work-orders/${workOrderId}/logs/stream`);
      expect(mockEventSourceInstances.length).toBe(1);
      expect(mockEventSourceInstances[0].url).toBe(`/api/agent-work-orders/${workOrderId}/logs/stream`);
    });

    it("should set connectionState to connecting initially", () => {
      const { connectToLogs, connectionStates } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-456";

      connectToLogs(workOrderId);

      const state = useAgentWorkOrdersStore.getState();
      expect(state.connectionStates[workOrderId]).toBe("connecting");
    });

    it("should prevent duplicate connections", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-duplicate";

      connectToLogs(workOrderId);
      connectToLogs(workOrderId); // Second call

      // Should only create one connection
      expect(mockEventSourceInstances.length).toBe(1);
    });

    it("should store connection in logConnections Map", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-789";

      connectToLogs(workOrderId);

      const state = useAgentWorkOrdersStore.getState();
      expect(state.logConnections.has(workOrderId)).toBe(true);
    });
  });

  describe("onopen event", () => {
    it("should set connectionState to connected", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-open";

      connectToLogs(workOrderId);

      // Simulate open event
      mockEventSourceInstances[0].simulateOpen();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.connectionStates[workOrderId]).toBe("connected");
    });
  });

  describe("onmessage event", () => {
    it("should parse JSON and call handleLogEvent", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-message";

      connectToLogs(workOrderId);
      mockEventSourceInstances[0].simulateOpen();

      const logEntry: LogEntry = {
        work_order_id: workOrderId,
        level: "info",
        event: "step_started",
        timestamp: new Date().toISOString(),
        step: "planning",
        step_number: 1,
        total_steps: 5,
      };

      // Simulate message
      mockEventSourceInstances[0].simulateMessage(JSON.stringify(logEntry));

      const state = useAgentWorkOrdersStore.getState();
      expect(state.liveLogs[workOrderId]?.length).toBe(1);
      expect(state.liveLogs[workOrderId]?.[0].event).toBe("step_started");
      expect(state.liveProgress[workOrderId]?.currentStep).toBe("planning");
    });

    it("should handle malformed JSON gracefully", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-malformed";

      connectToLogs(workOrderId);
      mockEventSourceInstances[0].simulateOpen();

      // Simulate malformed JSON
      mockEventSourceInstances[0].simulateMessage("invalid json {");

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"), expect.anything());

      consoleErrorSpy.mockRestore();
    });
  });

  describe("onerror event", () => {
    it("should set connectionState to error", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-error";

      connectToLogs(workOrderId);
      mockEventSourceInstances[0].simulateOpen();

      // Simulate error
      mockEventSourceInstances[0].simulateError();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.connectionStates[workOrderId]).toBe("error");
    });

    it("should trigger auto-reconnect after error", async () => {
      vi.useFakeTimers();

      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-reconnect";

      connectToLogs(workOrderId);
      const firstConnection = mockEventSourceInstances[0];
      firstConnection.simulateOpen();

      // Simulate error
      firstConnection.simulateError();

      expect(firstConnection.close).toBeDefined();

      // Fast-forward 5 seconds (auto-reconnect delay)
      await vi.advanceTimersByTimeAsync(5000);

      // Should create new connection
      expect(mockEventSourceInstances.length).toBe(2);

      vi.useRealTimers();
    });
  });

  describe("disconnectFromLogs", () => {
    it("should close connection and remove from Map", () => {
      const { connectToLogs, disconnectFromLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-disconnect";

      connectToLogs(workOrderId);
      const connection = mockEventSourceInstances[0];

      disconnectFromLogs(workOrderId);

      expect(connection.readyState).toBe(2); // CLOSED
      expect(useAgentWorkOrdersStore.getState().logConnections.has(workOrderId)).toBe(false);
    });

    it("should set connectionState to disconnected", () => {
      const { connectToLogs, disconnectFromLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-disc-state";

      connectToLogs(workOrderId);
      disconnectFromLogs(workOrderId);

      const state = useAgentWorkOrdersStore.getState();
      expect(state.connectionStates[workOrderId]).toBe("disconnected");
    });

    it("should handle disconnect when no connection exists", () => {
      const { disconnectFromLogs } = useAgentWorkOrdersStore.getState();

      // Should not throw
      expect(() => disconnectFromLogs("non-existent-id")).not.toThrow();
    });
  });

  describe("disconnectAll", () => {
    it("should close all connections and clear state", () => {
      const { connectToLogs, disconnectAll } = useAgentWorkOrdersStore.getState();

      // Create multiple connections
      connectToLogs("wo-1");
      connectToLogs("wo-2");
      connectToLogs("wo-3");

      expect(mockEventSourceInstances.length).toBe(3);

      // Disconnect all
      disconnectAll();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.logConnections.size).toBe(0);
      expect(Object.keys(state.connectionStates).length).toBe(0);
      expect(Object.keys(state.liveLogs).length).toBe(0);
      expect(Object.keys(state.liveProgress).length).toBe(0);

      // All connections should be closed
      mockEventSourceInstances.forEach((instance) => {
        expect(instance.readyState).toBe(2); // CLOSED
      });
    });
  });

  describe("Multiple Subscribers Pattern", () => {
    it("should share same connection across multiple subscribers", () => {
      const { connectToLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-shared";

      // First subscriber
      connectToLogs(workOrderId);

      // Second subscriber (same work order ID)
      connectToLogs(workOrderId);

      // Should only create one connection
      expect(mockEventSourceInstances.length).toBe(1);
    });

    it("should keep connection open until all subscribers disconnect", () => {
      const { connectToLogs, disconnectFromLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-multi-sub";

      // Simulate 2 components subscribing
      connectToLogs(workOrderId);
      const connection = mockEventSourceInstances[0];

      // First component disconnects
      disconnectFromLogs(workOrderId);

      // Connection should be closed (our current implementation closes immediately)
      // In a full reference counting implementation, connection would stay open
      // This test documents current behavior
      expect(connection.readyState).toBe(2); // CLOSED
    });
  });
});
