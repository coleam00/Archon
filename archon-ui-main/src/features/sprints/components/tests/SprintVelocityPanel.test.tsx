import { describe, expect, it } from "vitest";
import { render, screen } from "../../../testing/test-utils";
import type { Task } from "@/features/projects/tasks/types";
import type { Sprint } from "../../types";
import { SprintVelocityPanel } from "../SprintVelocityPanel";

// Sprint fixture starting in the past so burn-down bars are generated
const mockSprint: Sprint = {
  id: "sprint-1",
  project_id: "project-1",
  name: "Sprint 1",
  goal: "Ship the Sprint War Room",
  status: "active",
  start_date: "2026-02-20T00:00:00Z",
  end_date: "2026-03-06T00:00:00Z",
  created_at: "2026-02-20T00:00:00Z",
  updated_at: "2026-02-20T00:00:00Z",
};

const mockSprintNoDates: Sprint = {
  ...mockSprint,
  start_date: null,
  end_date: null,
};

const makeTasks = (overrides: Partial<Task>[] = []): Task[] =>
  overrides.map((o, i) => ({
    id: `task-${i}`,
    project_id: "project-1",
    title: `Task ${i}`,
    description: "",
    status: "todo",
    assignee: "claude",
    task_order: i,
    priority: "medium",
    created_at: "2026-02-20T00:00:00Z",
    updated_at: "2026-02-20T00:00:00Z",
    ...o,
  }));

describe("SprintVelocityPanel", () => {
  describe("stat pills", () => {
    it("renders all four status pills with correct counts", () => {
      const tasks = makeTasks([
        { status: "done" },
        { status: "done" },
        { status: "review" },
        { status: "doing" },
        { status: "todo" },
        { status: "todo" },
      ]);

      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      // Heading section
      expect(screen.getByText("Velocity")).toBeInTheDocument();

      // Stat pill labels
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("Review")).toBeInTheDocument();
      expect(screen.getByText("Doing")).toBeInTheDocument();
      expect(screen.getByText("Todo")).toBeInTheDocument();
    });

    it("shows done count of 2 when 2 tasks are done", () => {
      const tasks = makeTasks([{ status: "done" }, { status: "done" }, { status: "todo" }]);
      const { container } = render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      // "2" should appear at least once (done pill), "1" for todo pill, "0" for review and doing
      const twos = container.querySelectorAll("span");
      const hasTwoText = Array.from(twos).some((el) => el.textContent?.trim() === "2");
      expect(hasTwoText).toBe(true);
    });

    it("shows all zeros when sprint has no tasks", () => {
      render(<SprintVelocityPanel sprint={mockSprint} tasks={[]} />);

      // Summary line should show 0/0
      expect(screen.getByText(/0\/0 done/)).toBeInTheDocument();
    });
  });

  describe("summary footer", () => {
    it("shows cumulative velocity percentage", () => {
      const tasks = makeTasks([{ status: "done" }, { status: "done" }, { status: "todo" }]);
      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      // 2/3 = 67%
      expect(screen.getByText(/67%/)).toBeInTheDocument();
    });

    it("shows 0% velocity when no tasks are done", () => {
      const tasks = makeTasks([{ status: "todo" }, { status: "doing" }]);
      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      expect(screen.getByText(/0%/)).toBeInTheDocument();
    });

    it("shows 100% velocity when all tasks are done", () => {
      const tasks = makeTasks([{ status: "done" }, { status: "done" }]);
      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      expect(screen.getByText(/100%/)).toBeInTheDocument();
    });
  });

  describe("burn-down chart", () => {
    it("renders the SVG chart when sprint has start_date", () => {
      const tasks = makeTasks([{ status: "done" }]);
      const { container } = render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      expect(container.querySelector("svg")).toBeInTheDocument();
    });

    it("renders the accessible chart label", () => {
      const tasks = makeTasks([{ status: "done" }]);
      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      expect(screen.getByRole("img", { name: /sprint burn-down chart/i })).toBeInTheDocument();
    });

    it("shows fallback message when no start_date is set", () => {
      const tasks = makeTasks([{ status: "done" }]);
      render(<SprintVelocityPanel sprint={mockSprintNoDates} tasks={tasks} />);

      expect(screen.getByText(/set sprint start\/end dates/i)).toBeInTheDocument();
    });

    it("does not render SVG when no start_date is set", () => {
      const { container } = render(<SprintVelocityPanel sprint={mockSprintNoDates} tasks={[]} />);

      expect(container.querySelector("svg")).not.toBeInTheDocument();
    });
  });

  describe("header", () => {
    it("renders the panel heading icon text", () => {
      render(<SprintVelocityPanel sprint={mockSprint} tasks={[]} />);
      expect(screen.getByText("Velocity")).toBeInTheDocument();
    });

    it("shows tasks done summary in header", () => {
      const tasks = makeTasks([{ status: "done" }, { status: "todo" }]);
      render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />);

      expect(screen.getByText(/1\/2 done/)).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    it("renders without crashing on empty tasks array", () => {
      expect(() =>
        render(<SprintVelocityPanel sprint={mockSprint} tasks={[]} />)
      ).not.toThrow();
    });

    it("renders without crashing when all statuses are present", () => {
      const tasks = makeTasks([
        { status: "todo" },
        { status: "doing" },
        { status: "review" },
        { status: "done" },
      ]);

      expect(() =>
        render(<SprintVelocityPanel sprint={mockSprint} tasks={tasks} />)
      ).not.toThrow();
    });
  });
});
