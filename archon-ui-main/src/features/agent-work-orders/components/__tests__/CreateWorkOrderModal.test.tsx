/**
 * CreateWorkOrderModal Component Tests
 *
 * Tests for create work order modal form validation and submission.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateWorkOrderModal } from "../CreateWorkOrderModal";

// Mock the hooks
vi.mock("../../hooks/useAgentWorkOrderQueries", () => ({
  useCreateWorkOrder: () => ({
    mutateAsync: vi.fn().mockResolvedValue({
      agent_work_order_id: "wo-new",
      status: "pending",
    }),
  }),
}));

vi.mock("../../hooks/useRepositoryQueries", () => ({
  useRepositories: () => ({
    data: [
      {
        id: "repo-1",
        repository_url: "https://github.com/test/repo",
        display_name: "test/repo",
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning", "execute"],
      },
    ],
  }),
}));

vi.mock("@/features/ui/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

describe("CreateWorkOrderModal", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("should render when open", () => {
    render(<CreateWorkOrderModal open={true} onOpenChange={vi.fn()} />, { wrapper });

    expect(screen.getByText("Create Work Order")).toBeInTheDocument();
  });

  it("should not render when closed", () => {
    render(<CreateWorkOrderModal open={false} onOpenChange={vi.fn()} />, { wrapper });

    expect(screen.queryByText("Create Work Order")).not.toBeInTheDocument();
  });

  it("should pre-populate fields from selected repository", async () => {
    render(<CreateWorkOrderModal open={true} onOpenChange={vi.fn()} selectedRepositoryId="repo-1" />, {
      wrapper,
    });

    // Wait for repository data to be populated
    await waitFor(() => {
      const urlInput = screen.getByLabelText("Repository URL") as HTMLInputElement;
      expect(urlInput.value).toBe("https://github.com/test/repo");
    });
  });

  it("should show validation error for empty request", async () => {
    const user = userEvent.setup();

    render(<CreateWorkOrderModal open={true} onOpenChange={vi.fn()} />, { wrapper });

    // Try to submit without filling required fields
    const submitButton = screen.getByRole("button", { name: "Create Work Order" });
    await user.click(submitButton);

    // Should show validation error
    await waitFor(() => {
      expect(screen.getByText(/Request must be at least 10 characters/i)).toBeInTheDocument();
    });
  });

  it("should disable commit and PR steps when execute is not selected", async () => {
    const user = userEvent.setup();

    render(<CreateWorkOrderModal open={true} onOpenChange={vi.fn()} />, { wrapper });

    // Uncheck execute step
    const executeCheckbox = screen.getByLabelText("Execute");
    await user.click(executeCheckbox);

    // Commit and PR should be disabled
    const commitCheckbox = screen.getByLabelText("Commit Changes") as HTMLInputElement;
    const prCheckbox = screen.getByLabelText("Create Pull Request") as HTMLInputElement;

    expect(commitCheckbox).toBeDisabled();
    expect(prCheckbox).toBeDisabled();
  });

  it("should have accessible form labels", () => {
    render(<CreateWorkOrderModal open={true} onOpenChange={vi.fn()} />, { wrapper });

    expect(screen.getByLabelText("Repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Work Request")).toBeInTheDocument();
  });
});
