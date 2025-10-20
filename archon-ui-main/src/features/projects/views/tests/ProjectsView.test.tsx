import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { renderWithProviders } from "../../../testing/test-utils";
import { ProjectsView } from "../ProjectsView";

// Mock hooks
vi.mock("../../hooks/useProjectQueries", () => ({
  projectKeys: {
    all: ["projects"] as const,
    lists: () => ["projects", "list"] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    features: (id: string) => ["projects", id, "features"] as const,
  },
  useProjects: vi.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
  useUpdateProject: vi.fn(() => ({
    mutate: vi.fn(),
  })),
  useDeleteProject: vi.fn(() => ({
    mutate: vi.fn(),
  })),
}));

vi.mock("../../tasks/hooks", () => ({
  useTaskCounts: vi.fn(() => ({
    data: {},
    refetch: vi.fn(),
  })),
}));

// Mock shared patterns
vi.mock("../../../shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Infinity,
  },
  createRetryLogic: () => false,
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

// Mock hooks
vi.mock("../../../hooks/useStaggeredEntrance", () => ({
  useStaggeredEntrance: () => true,
}));

describe("ProjectsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderProjectsView = () => {
    return renderWithProviders(
      <BrowserRouter>
        <ProjectsView />
      </BrowserRouter>
    );
  };

  it("renders projects view correctly", () => {
    const { container } = renderProjectsView();
    expect(container).toBeTruthy();
  });

  it("displays new project button", () => {
    renderProjectsView();
    expect(screen.getByText(/new project/i)).toBeInTheDocument();
  });

  it("matches snapshot", () => {
    const { container } = renderProjectsView();
    expect(container).toMatchSnapshot();
  });
});
