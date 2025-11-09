/**
 * Unit tests for Agent Work Orders Zustand Store
 *
 * Tests all slices: UI Preferences, Modals, Filters, and SSE
 * Verifies state management (persist middleware handles localStorage automatically)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../../types";
import type { ConfiguredRepository } from "../../types/repository";
import { useAgentWorkOrdersStore } from "../agentWorkOrdersStore";

describe("AgentWorkOrdersStore", () => {
  beforeEach(() => {
    // Reset store to initial state
    useAgentWorkOrdersStore.setState({
      // UI Preferences
      layoutMode: "sidebar",
      sidebarExpanded: true,
      // Modals
      showAddRepoModal: false,
      showEditRepoModal: false,
      showCreateWorkOrderModal: false,
      editingRepository: null,
      preselectedRepositoryId: undefined,
      // Filters
      searchQuery: "",
      selectedRepositoryId: undefined,
      // SSE
      logConnections: new Map(),
      connectionStates: {},
      liveLogs: {},
      liveProgress: {},
    });

    // Clear localStorage
    localStorage.clear();
  });

  afterEach(() => {
    // Disconnect all SSE connections
    const { disconnectAll } = useAgentWorkOrdersStore.getState();
    disconnectAll();
  });

  describe("UI Preferences Slice", () => {
    it("should set layout mode", () => {
      const { setLayoutMode } = useAgentWorkOrdersStore.getState();
      setLayoutMode("horizontal");

      expect(useAgentWorkOrdersStore.getState().layoutMode).toBe("horizontal");
    });

    it("should toggle sidebar expansion", () => {
      const { toggleSidebar } = useAgentWorkOrdersStore.getState();
      toggleSidebar();

      expect(useAgentWorkOrdersStore.getState().sidebarExpanded).toBe(false);
    });

    it("should set sidebar expanded directly", () => {
      const { setSidebarExpanded } = useAgentWorkOrdersStore.getState();
      setSidebarExpanded(false);

      expect(useAgentWorkOrdersStore.getState().sidebarExpanded).toBe(false);
    });

    it("should reset UI preferences to defaults", () => {
      const { setLayoutMode, setSidebarExpanded, resetUIPreferences } = useAgentWorkOrdersStore.getState();

      // Change values
      setLayoutMode("horizontal");
      setSidebarExpanded(false);

      // Reset
      resetUIPreferences();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.layoutMode).toBe("sidebar");
      expect(state.sidebarExpanded).toBe(true);
    });
  });

  describe("Modals Slice", () => {
    it("should open and close add repository modal", () => {
      const { openAddRepoModal, closeAddRepoModal } = useAgentWorkOrdersStore.getState();

      openAddRepoModal();
      expect(useAgentWorkOrdersStore.getState().showAddRepoModal).toBe(true);

      closeAddRepoModal();
      expect(useAgentWorkOrdersStore.getState().showAddRepoModal).toBe(false);
    });

    it("should open edit modal with repository context", () => {
      const mockRepo: ConfiguredRepository = {
        id: "repo-123",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        owner: "test",
        default_branch: "main",
        is_verified: true,
        last_verified_at: new Date().toISOString(),
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { openEditRepoModal, closeEditRepoModal } = useAgentWorkOrdersStore.getState();

      openEditRepoModal(mockRepo);
      expect(useAgentWorkOrdersStore.getState().showEditRepoModal).toBe(true);
      expect(useAgentWorkOrdersStore.getState().editingRepository).toBe(mockRepo);

      closeEditRepoModal();
      expect(useAgentWorkOrdersStore.getState().showEditRepoModal).toBe(false);
      expect(useAgentWorkOrdersStore.getState().editingRepository).toBe(null);
    });

    it("should open create work order modal with preselected repository", () => {
      const { openCreateWorkOrderModal, closeCreateWorkOrderModal } = useAgentWorkOrdersStore.getState();

      openCreateWorkOrderModal("repo-456");
      expect(useAgentWorkOrdersStore.getState().showCreateWorkOrderModal).toBe(true);
      expect(useAgentWorkOrdersStore.getState().preselectedRepositoryId).toBe("repo-456");

      closeCreateWorkOrderModal();
      expect(useAgentWorkOrdersStore.getState().showCreateWorkOrderModal).toBe(false);
      expect(useAgentWorkOrdersStore.getState().preselectedRepositoryId).toBeUndefined();
    });

    it("should close all modals and clear context", () => {
      const mockRepo: ConfiguredRepository = {
        id: "repo-123",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        owner: "test",
        default_branch: "main",
        is_verified: true,
        last_verified_at: new Date().toISOString(),
        default_sandbox_type: "git_worktree",
        default_commands: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { openAddRepoModal, openEditRepoModal, openCreateWorkOrderModal, closeAllModals } =
        useAgentWorkOrdersStore.getState();

      // Open all modals
      openAddRepoModal();
      openEditRepoModal(mockRepo);
      openCreateWorkOrderModal("repo-789");

      // Close all
      closeAllModals();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.showAddRepoModal).toBe(false);
      expect(state.showEditRepoModal).toBe(false);
      expect(state.showCreateWorkOrderModal).toBe(false);
      expect(state.editingRepository).toBe(null);
      expect(state.preselectedRepositoryId).toBeUndefined();
    });
  });

  describe("Filters Slice", () => {
    it("should set search query", () => {
      const { setSearchQuery } = useAgentWorkOrdersStore.getState();
      setSearchQuery("my-repo");

      expect(useAgentWorkOrdersStore.getState().searchQuery).toBe("my-repo");
    });

    it("should select repository with URL sync callback", () => {
      const mockSyncUrl = vi.fn();
      const { selectRepository } = useAgentWorkOrdersStore.getState();

      selectRepository("repo-123", mockSyncUrl);

      expect(useAgentWorkOrdersStore.getState().selectedRepositoryId).toBe("repo-123");
      expect(mockSyncUrl).toHaveBeenCalledWith("repo-123");
    });

    it("should clear all filters", () => {
      const { setSearchQuery, selectRepository, clearFilters } = useAgentWorkOrdersStore.getState();

      // Set some filters
      setSearchQuery("test");
      selectRepository("repo-456");

      // Clear
      clearFilters();

      const state = useAgentWorkOrdersStore.getState();
      expect(state.searchQuery).toBe("");
      expect(state.selectedRepositoryId).toBeUndefined();
    });
  });

  describe("SSE Slice", () => {
    it("should parse step_started log and calculate correct progress", () => {
      const { handleLogEvent } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-123";

      const stepStartedLog: LogEntry = {
        work_order_id: workOrderId,
        level: "info",
        event: "step_started",
        timestamp: new Date().toISOString(),
        step: "planning",
        step_number: 2,
        total_steps: 5,
        elapsed_seconds: 15,
      };

      handleLogEvent(workOrderId, stepStartedLog);

      const progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
      expect(progress?.currentStep).toBe("planning");
      expect(progress?.stepNumber).toBe(2);
      expect(progress?.totalSteps).toBe(5);
      // Progress based on completed steps: (2-1)/5 = 20%
      expect(progress?.progressPct).toBe(20);
      expect(progress?.elapsedSeconds).toBe(15);
    });

    it("should parse workflow_completed log and update status", () => {
      const { handleLogEvent } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-456";

      const completedLog: LogEntry = {
        work_order_id: workOrderId,
        level: "info",
        event: "workflow_completed",
        timestamp: new Date().toISOString(),
      };

      handleLogEvent(workOrderId, completedLog);

      const progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
      expect(progress?.status).toBe("completed");
    });

    it("should parse workflow_failed log and update status", () => {
      const { handleLogEvent } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-789";

      const failedLog: LogEntry = {
        work_order_id: workOrderId,
        level: "error",
        event: "workflow_failed",
        timestamp: new Date().toISOString(),
        error: "Something went wrong",
      };

      handleLogEvent(workOrderId, failedLog);

      const progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
      expect(progress?.status).toBe("failed");
    });

    it("should maintain max 500 log entries", () => {
      const { handleLogEvent } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-overflow";

      // Add 600 logs
      for (let i = 0; i < 600; i++) {
        const log: LogEntry = {
          work_order_id: workOrderId,
          level: "info",
          event: `event_${i}`,
          timestamp: new Date().toISOString(),
        };
        handleLogEvent(workOrderId, log);
      }

      const logs = useAgentWorkOrdersStore.getState().liveLogs[workOrderId];
      expect(logs.length).toBe(500);
      // Should keep most recent logs
      expect(logs[logs.length - 1].event).toBe("event_599");
    });

    it("should clear logs for specific work order", () => {
      const { handleLogEvent, clearLogs } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-clear";

      // Add some logs
      const log: LogEntry = {
        work_order_id: workOrderId,
        level: "info",
        event: "test_event",
        timestamp: new Date().toISOString(),
      };
      handleLogEvent(workOrderId, log);

      expect(useAgentWorkOrdersStore.getState().liveLogs[workOrderId]?.length).toBe(1);

      // Clear
      clearLogs(workOrderId);

      expect(useAgentWorkOrdersStore.getState().liveLogs[workOrderId]?.length).toBe(0);
    });

    it("should accumulate progress metadata correctly", () => {
      const { handleLogEvent } = useAgentWorkOrdersStore.getState();
      const workOrderId = "wo-progress";

      // First log with step info - step 1 starting
      handleLogEvent(workOrderId, {
        work_order_id: workOrderId,
        level: "info",
        event: "step_started",
        timestamp: new Date().toISOString(),
        step: "planning",
        step_number: 1,
        total_steps: 3,
      });

      let progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
      expect(progress?.currentStep).toBe("planning");
      expect(progress?.stepNumber).toBe(1);
      expect(progress?.totalSteps).toBe(3);
      // Step 1 of 3 starting: (1-1)/3 = 0%
      expect(progress?.progressPct).toBe(0);

      // Step completed
      handleLogEvent(workOrderId, {
        work_order_id: workOrderId,
        level: "info",
        event: "step_completed",
        timestamp: new Date().toISOString(),
        elapsed_seconds: 30,
      });

      progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
      // Step 1 complete: 1/3 = 33%
      expect(progress?.progressPct).toBe(33);
      expect(progress?.elapsedSeconds).toBe(30);
    });
  });

  describe("State Management", () => {
    it("should manage all state types correctly", () => {
      const { setLayoutMode, setSearchQuery, openAddRepoModal, handleLogEvent } = useAgentWorkOrdersStore.getState();

      // Set UI preferences
      setLayoutMode("horizontal");

      // Set filters
      setSearchQuery("test-query");

      // Set modals
      openAddRepoModal();

      // Add SSE data
      handleLogEvent("wo-test", {
        work_order_id: "wo-test",
        level: "info",
        event: "test",
        timestamp: new Date().toISOString(),
      });

      const state = useAgentWorkOrdersStore.getState();

      // Verify all state is correct (persist middleware handles localStorage)
      expect(state.layoutMode).toBe("horizontal");
      expect(state.searchQuery).toBe("test-query");
      expect(state.showAddRepoModal).toBe(true);
      expect(state.liveLogs["wo-test"]?.length).toBe(1);
    });
  });

  describe("Selective Subscriptions", () => {
    it("should only trigger updates when subscribed field changes", () => {
      const layoutModeCallback = vi.fn();
      const searchQueryCallback = vi.fn();

      // Subscribe to specific fields
      const unsubLayoutMode = useAgentWorkOrdersStore.subscribe((state) => state.layoutMode, layoutModeCallback);

      const unsubSearchQuery = useAgentWorkOrdersStore.subscribe((state) => state.searchQuery, searchQueryCallback);

      // Change layoutMode - should trigger layoutMode callback only
      const { setLayoutMode } = useAgentWorkOrdersStore.getState();
      setLayoutMode("horizontal");

      expect(layoutModeCallback).toHaveBeenCalledWith("horizontal", "sidebar");
      expect(searchQueryCallback).not.toHaveBeenCalled();

      // Clear mock calls
      layoutModeCallback.mockClear();
      searchQueryCallback.mockClear();

      // Change searchQuery - should trigger searchQuery callback only
      const { setSearchQuery } = useAgentWorkOrdersStore.getState();
      setSearchQuery("new-query");

      expect(searchQueryCallback).toHaveBeenCalledWith("new-query", "");
      expect(layoutModeCallback).not.toHaveBeenCalled();

      // Cleanup
      unsubLayoutMode();
      unsubSearchQuery();
    });
  });
});
