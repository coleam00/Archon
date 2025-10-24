/**
 * Tests for RealTimeStats Component
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RealTimeStats } from "../RealTimeStats";
import type { LogEntry } from "../../types";

// Mock the hooks
vi.mock("../../hooks/useWorkOrderLogs", () => ({
	useWorkOrderLogs: vi.fn(() => ({
		logs: [],
	})),
}));

vi.mock("../../hooks/useLogStats", () => ({
	useLogStats: vi.fn(() => ({
		currentStep: null,
		currentStepNumber: null,
		totalSteps: null,
		progressPct: null,
		elapsedSeconds: null,
		lastActivity: null,
		currentActivity: null,
		hasStarted: false,
		hasCompleted: false,
		hasFailed: false,
	})),
}));

describe("RealTimeStats", () => {
	it("should not render when no logs available", () => {
		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: [] });
		useLogStats.mockReturnValue({
			currentStep: null,
			currentStepNumber: null,
			totalSteps: null,
			progressPct: null,
			elapsedSeconds: null,
			lastActivity: null,
			currentActivity: null,
			hasStarted: false,
			hasCompleted: false,
			hasFailed: false,
		});

		const { container } = render(<RealTimeStats workOrderId="wo-123" />);

		expect(container.firstChild).toBeNull();
	});

	it("should render with basic stats", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_started",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "planning",
			currentStepNumber: 2,
			totalSteps: 5,
			progressPct: 40,
			elapsedSeconds: 120,
			lastActivity: new Date().toISOString(),
			currentActivity: "Analyzing codebase",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: false,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		expect(screen.getByText("Real-Time Execution")).toBeInTheDocument();
		expect(screen.getByText("planning")).toBeInTheDocument();
		expect(screen.getByText("(2/5)")).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
		expect(screen.getByText("Analyzing codebase")).toBeInTheDocument();
	});

	it("should show progress bar at correct percentage", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_started",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "execute",
			currentStepNumber: 3,
			totalSteps: 5,
			progressPct: 60,
			elapsedSeconds: 180,
			lastActivity: new Date().toISOString(),
			currentActivity: "Running tests",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: false,
		});

		const { container } = render(<RealTimeStats workOrderId="wo-123" />);

		// Find progress bar div
		const progressBar = container.querySelector('[style*="width: 60%"]');
		expect(progressBar).toBeInTheDocument();
	});

	it("should show completed status", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_completed",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "create-pr",
			currentStepNumber: 5,
			totalSteps: 5,
			progressPct: 100,
			elapsedSeconds: 300,
			lastActivity: new Date().toISOString(),
			currentActivity: "Pull request created",
			hasStarted: true,
			hasCompleted: true,
			hasFailed: false,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		expect(screen.getByText("Completed")).toBeInTheDocument();
	});

	it("should show failed status", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "error",
				event: "workflow_failed",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "execute",
			currentStepNumber: 3,
			totalSteps: 5,
			progressPct: 60,
			elapsedSeconds: 150,
			lastActivity: new Date().toISOString(),
			currentActivity: "Error executing command",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: true,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("should show running status", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "step_started",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "planning",
			currentStepNumber: 2,
			totalSteps: 5,
			progressPct: 40,
			elapsedSeconds: 90,
			lastActivity: new Date().toISOString(),
			currentActivity: "Generating plan",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: false,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		expect(screen.getByText("Running")).toBeInTheDocument();
	});

	it("should handle missing progress percentage", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_started",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "planning",
			currentStepNumber: null,
			totalSteps: null,
			progressPct: null,
			elapsedSeconds: 30,
			lastActivity: new Date().toISOString(),
			currentActivity: "Initializing",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: false,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		expect(screen.getByText("Calculating...")).toBeInTheDocument();
	});

	it("should format elapsed time correctly", () => {
		const mockLogs: LogEntry[] = [
			{
				work_order_id: "wo-123",
				level: "info",
				event: "workflow_started",
				timestamp: new Date().toISOString(),
			},
		];

		const { useWorkOrderLogs } = require("../../hooks/useWorkOrderLogs");
		const { useLogStats } = require("../../hooks/useLogStats");

		// Test with 125 seconds (2m 5s)
		useWorkOrderLogs.mockReturnValue({ logs: mockLogs });
		useLogStats.mockReturnValue({
			currentStep: "planning",
			currentStepNumber: 2,
			totalSteps: 5,
			progressPct: 40,
			elapsedSeconds: 125,
			lastActivity: new Date().toISOString(),
			currentActivity: "Working",
			hasStarted: true,
			hasCompleted: false,
			hasFailed: false,
		});

		render(<RealTimeStats workOrderId="wo-123" />);

		// Should show minutes and seconds
		expect(screen.getByText(/2m 5s/)).toBeInTheDocument();
	});
});
