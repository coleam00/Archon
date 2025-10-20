import { describe, it, expect, vi } from "vitest";
import { render } from "../../../testing/test-utils";
import { KnowledgeCard } from "../KnowledgeCard";
import type { KnowledgeItem } from "../../types";

// Mock hooks
vi.mock("../../hooks", () => ({
  useDeleteKnowledgeItem: vi.fn(() => ({
    mutateAsync: vi.fn(),
  })),
  useRefreshKnowledgeItem: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useUpdateKnowledgeItem: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useUpdateKnowledgeItemTags: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

describe("KnowledgeCard", () => {
  const mockItem: KnowledgeItem = {
    source_id: "test-id",
    url: "https://example.com",
    source_type: "url",
    status: "completed",
    title: "Test Knowledge Item",
    knowledge_type: "technical",
    document_count: 10,
    code_examples_count: 5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {
      description: "Test description",
      tags: ["test", "example"],
    },
  };

  it("renders knowledge card correctly", () => {
    const { container } = render(
      <KnowledgeCard
        item={mockItem}
        onViewDocument={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    );
    expect(container).toBeTruthy();
  });

  it("displays item title", () => {
    const { getByText } = render(
      <KnowledgeCard
        item={mockItem}
        onViewDocument={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    );
    expect(getByText("Test Knowledge Item")).toBeInTheDocument();
  });

  it("displays document count", () => {
    const { getByLabelText } = render(
      <KnowledgeCard
        item={mockItem}
        onViewDocument={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    );
    expect(getByLabelText("Documents count")).toBeInTheDocument();
  });

  it("displays code examples count", () => {
    const { getByLabelText } = render(
      <KnowledgeCard
        item={mockItem}
        onViewDocument={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    );
    expect(getByLabelText("Code examples count")).toBeInTheDocument();
  });

  it("matches snapshot", () => {
    const { container } = render(
      <KnowledgeCard
        item={mockItem}
        onViewDocument={vi.fn()}
        onDeleteSuccess={vi.fn()}
      />
    );
    expect(container).toMatchSnapshot();
  });
});
