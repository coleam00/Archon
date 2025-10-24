/**
 * Tests for WorkOrderLogsPanel Component
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkOrderLogsPanel } from "../WorkOrderLogsPanel";
import type { LogEntry } from "../../types";

// Mock the hooks
vi.mock("../../hooks/useWorkOrderLogs", () => ({
	useWorkOrderLogs: vi.fn(() => ({
		logs: [],
		connectionState: "disconnected",
		isConnected: false,
		error: null,
		reconnect: vi.fn(),
		clearLogs: vi.fn(),
	})),
}));

describe("WorkOrderLogsPanel", () => {
	it("should render with collapsed state by default", () => {
		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		expect(screen.getByText("Execution Logs")).toBeInTheDocument();
		expect(screen.queryByText("No logs yet")).not.toBeInTheDocument();
	});

	it("should expand when clicked", () => {
		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: [],
			connectionState: "connected",
			isConnected: true,
			error: null,
			reconnect: vi.fn(),
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		const expandButton = screen.getByRole("button", { name: /Execution Logs/i });
		fireEvent.click(expandButton);

		expect(screen.getByText("No logs yet. Waiting for execution...")).toBeInTheDocument();
	});

	it("should render logs when available", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_started",
				timestamp: new Date().toISOString(),
			},
			{
				work_order_id: "wo-123",
				level: "error",
				event: "step_failed",
				timestamp: new Date().toISOString(),
				step: "planning",
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: mockLogs,
			connectionState: "connected",
			isConnected: true,
			error: null,
			reconnect: vi.fn(),
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		// Expand panel
		const expandButton = screen.getByRole("button", { name: /Execution Logs/i });
		fireEvent.click(expandButton);

		expect(screen.getByText("workflow_started")).toBeInTheDocument();
		expect(screen.getByText("step_failed")).toBeInTheDocument();
		expect(screen.getByText("[planning]")).toBeInTheDocument();
	});

	it("should show connection status indicators", () => {
		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: [],
			connectionState: "connecting",
			isConnected: false,
			error: null,
			reconnect: vi.fn(),
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		expect(screen.getByText("Connecting...")).toBeInTheDocument();
	});

	it("should show error state with retry button", () => {
		const mockReconnect = vi.fn();
		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: [],
			connectionState: "error",
			isConnected: false,
			error: new Error("Connection failed"),
			reconnect: mockReconnect,
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		expect(screen.getByText("Disconnected")).toBeInTheDocument();

		// Expand to see error details
		const expandButton = screen.getByRole("button", { name: /Execution Logs/i });
		fireEvent.click(expandButton);

		expect(screen.getByText("Failed to connect to log stream")).toBeInTheDocument();

		const retryButton = screen.getByRole("button", { name: /Retry Connection/i });
		fireEvent.click(retryButton);

		expect(mockReconnect).toHaveBeenCalled();
	});

	it("should call clearLogs when clear button clicked", () => {
		const mockClearLogs = vi.fn();
		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: [
				{
					work_order_id: "wo-123",
					level: "info",
					event: "test",
					timestamp: new Date().toISOString(),
				},
			],
			connectionState: "connected",
			isConnected: true,
			error: null,
			reconnect: vi.fn(),
			clearLogs: mockClearLogs,
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		const clearButton = screen.getByRole("button", { name: /Clear logs/i });
		fireEvent.click(clearButton);

		expect(mockClearLogs).toHaveBeenCalled();
	});

	it("should filter logs by level", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "info_event",
				timestamp: new Date().toISOString(),
			},
			{
				work_order_id: "wo-123",
				level: "error",
				event: "error_event",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: mockLogs,
			connectionState: "connected",
			isConnected: true,
			error: null,
			reconnect: vi.fn(),
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		// Expand panel
		const expandButton = screen.getByRole("button", { name: /Execution Logs/i });
		fireEvent.click(expandButton);

		// Both logs should be visible initially
		expect(screen.getByText("info_event")).toBeInTheDocument();
		expect(screen.getByText("error_event")).toBeInTheDocument();

		// Filter by error level
		const levelFilter = screen.getByRole("combobox");
		fireEvent.change(levelFilter, { target: { value: "error" } });

		// Only error log should be visible
		expect(screen.queryByText("info_event")).not.toBeInTheDocument();
		expect(screen.getByText("error_event")).toBeInTheDocument();
	});

	it("should show entry count", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "event1",
				timestamp: new Date().toISOString(),
			},
			{
				work_order_id: "wo-123",
				level: "info",
				event: "event2",
				timestamp: new Date().toISOString(),
			},
			{
				work_order_id: "wo-123",
				level: "info",
				event: "event3",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		useWorkOrderLogs.mockReturnValue({
			logs: mockLogs,
			connectionState: "connected",
			isConnected: true,
			error: null,
			reconnect: vi.fn(),
			clearLogs: vi.fn(),
		});

		render(<WorkOrderLogsPanel workOrderId="wo-123" />);

		expect(screen.getByText("(3 entries)")).toBeInTheDocument();
	});
});
