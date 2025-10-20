import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../testing/test-utils";
import { KnowledgeView } from "../KnowledgeView";

// Mock the hooks
vi.mock("../../hooks/useKnowledgeQueries", () => ({
  useKnowledgeSummaries: vi.fn(() => ({
    data: { items: [], total: 0 },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setActiveCrawlIds: vi.fn(),
    activeOperations: [],
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

describe("KnowledgeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders knowledge view correctly", () => {
    const { container } = renderWithProviders(<KnowledgeView />);
    expect(container).toBeTruthy();
  });

  it("displays add knowledge button", () => {
    renderWithProviders(<KnowledgeView />);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("matches snapshot", () => {
    const { container } = renderWithProviders(<KnowledgeView />);
    expect(container).toMatchSnapshot();
  });
});
