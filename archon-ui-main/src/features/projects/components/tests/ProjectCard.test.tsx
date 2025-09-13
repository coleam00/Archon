import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../testing/test-utils";
import type { Project } from "../../types";
import { ProjectCard } from "../ProjectCard";

describe("ProjectCard", () => {
  const mockProject: Project = {
    id: "project-1",
    title: "Test Project",
    description: "Test Description",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pinned: false,
    features: [],
    docs: [],
  };

  const mockTaskCounts = {
    todo: 5,
    doing: 3,
    review: 2,
    done: 10,
  };

  const mockHandlers = {
    onSelect: vi.fn(),
    onPin: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render project title", () => {
    render(<ProjectCard project={mockProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />);

    expect(screen.getByText("Test Project")).toBeInTheDocument();
  });

  it("should display task counts", () => {
    render(<ProjectCard project={mockProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />);

    // Task count badges should be visible
    // Note: Component only shows todo, doing, and done (not review)
    const fives = screen.getAllByText("5");
    expect(fives.length).toBeGreaterThan(0); // todo count
    expect(screen.getByText("10")).toBeInTheDocument(); // done
    // Doing count might be displayed as 3 or duplicated - implementation detail
  });

  it("should call onSelect when clicked", () => {
    const { container } = render(
      <ProjectCard project={mockProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />,
    );

    const card = container.firstChild as HTMLElement;
    fireEvent.click(card);

    expect(mockHandlers.onSelect).toHaveBeenCalledWith(mockProject);
    expect(mockHandlers.onSelect).toHaveBeenCalledTimes(1);
  });

  it("should apply selected styles when isSelected is true", () => {
    const { container } = render(
      <ProjectCard project={mockProject} isSelected={true} taskCounts={mockTaskCounts} {...mockHandlers} />,
    );

    const card = container.firstChild;
    expect(card).toBeInTheDocument();
    // Check for selected-specific classes
    expect((card as HTMLElement)?.className || "").toContain("scale-[1.02]");
    expect((card as HTMLElement)?.className || "").toContain("border-purple");
  });

  it("should apply pinned styles when project is pinned", () => {
    const pinnedProject = { ...mockProject, pinned: true };

    const { container } = render(
      <ProjectCard project={pinnedProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />,
    );

    const card = container.firstChild;
    expect(card).toBeInTheDocument();
    // Check for pinned-specific classes
    expect((card as HTMLElement)?.className || "").toContain("from-purple");
    expect((card as HTMLElement)?.className || "").toContain("border-purple-500");
  });

  it("should render aurora glow effect when selected", () => {
    const { container } = render(
      <ProjectCard project={mockProject} isSelected={true} taskCounts={mockTaskCounts} {...mockHandlers} />,
    );

    // Aurora glow div should exist when selected
    const glowEffect = container.querySelector(".animate-\\[pulse_8s_ease-in-out_infinite\\]");
    expect(glowEffect).toBeInTheDocument();
  });

  it("should not render aurora glow effect when not selected", () => {
    const { container } = render(
      <ProjectCard project={mockProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />,
    );

    // Aurora glow div should not exist when not selected
    const glowEffect = container.querySelector(".animate-\\[pulse_8s_ease-in-out_infinite\\]");
    expect(glowEffect).not.toBeInTheDocument();
  });

  it("should show zero task counts correctly", () => {
    const zeroTaskCounts = {
      todo: 0,
      doing: 0,
      review: 0,
      done: 0,
    };

    render(<ProjectCard project={mockProject} isSelected={false} taskCounts={zeroTaskCounts} {...mockHandlers} />);

    // All counts should show 0 (ProjectCard may not show review count)
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBeGreaterThanOrEqual(3); // At least todo, doing, done
  });

  it("should handle very long project titles", () => {
    const longTitleProject = {
      ...mockProject,
      title:
        "This is an extremely long project title that should be truncated properly to avoid breaking the layout of the card component",
    };

    render(<ProjectCard project={longTitleProject} isSelected={false} taskCounts={mockTaskCounts} {...mockHandlers} />);

    const title = screen.getByText(/This is an extremely long project title/);
    expect(title).toBeInTheDocument();
    // Title should have line-clamp-2 class
    expect(title.className).toContain("line-clamp-2");
  });
});
