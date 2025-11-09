/**
 * RepositoryCard Component Tests
 *
 * Tests for repository card rendering and interactions.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfiguredRepository } from "../../types/repository";
import { RepositoryCard } from "../RepositoryCard";

const mockRepository: ConfiguredRepository = {
  id: "repo-1",
  repository_url: "https://github.com/test/repository",
  display_name: "test/repository",
  owner: "test",
  default_branch: "main",
  is_verified: true,
  last_verified_at: "2024-01-01T00:00:00Z",
  default_sandbox_type: "git_worktree",
  default_commands: ["create-branch", "planning", "execute"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("RepositoryCard", () => {
  it("should render repository name and URL", () => {
    render(<RepositoryCard repository={mockRepository} stats={{ total: 5, active: 2, done: 3 }} />);

    expect(screen.getByText("test/repository")).toBeInTheDocument();
    expect(screen.getByText(/test\/repository/)).toBeInTheDocument();
  });

  it("should display work order stats", () => {
    render(<RepositoryCard repository={mockRepository} stats={{ total: 5, active: 2, done: 3 }} />);

    expect(screen.getByLabelText("5 total work orders")).toBeInTheDocument();
    expect(screen.getByLabelText("2 active work orders")).toBeInTheDocument();
    expect(screen.getByLabelText("3 completed work orders")).toBeInTheDocument();
  });

  it("should show verified status when repository is verified", () => {
    render(<RepositoryCard repository={mockRepository} stats={{ total: 0, active: 0, done: 0 }} />);

    expect(screen.getByText("✓ Verified")).toBeInTheDocument();
  });

  it("should call onSelect when clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<RepositoryCard repository={mockRepository} onSelect={onSelect} stats={{ total: 0, active: 0, done: 0 }} />);

    const card = screen.getByRole("button", { name: /test\/repository/i });
    await user.click(card);

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("should show pin indicator when isPinned is true", () => {
    render(<RepositoryCard repository={mockRepository} isPinned={true} stats={{ total: 0, active: 0, done: 0 }} />);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
  });

  it("should call onPin when pin button clicked", async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();

    render(<RepositoryCard repository={mockRepository} onPin={onPin} stats={{ total: 0, active: 0, done: 0 }} />);

    const pinButton = screen.getByLabelText("Pin repository");
    await user.click(pinButton);

    expect(onPin).toHaveBeenCalledOnce();
  });

  it("should call onDelete when delete button clicked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(<RepositoryCard repository={mockRepository} onDelete={onDelete} stats={{ total: 0, active: 0, done: 0 }} />);

    const deleteButton = screen.getByLabelText("Delete repository");
    await user.click(deleteButton);

    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("should support keyboard navigation (Enter key)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<RepositoryCard repository={mockRepository} onSelect={onSelect} stats={{ total: 0, active: 0, done: 0 }} />);

    const card = screen.getByRole("button", { name: /test\/repository/i });
    card.focus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("should have proper ARIA attributes", () => {
    render(<RepositoryCard repository={mockRepository} isSelected={true} stats={{ total: 0, active: 0, done: 0 }} />);

    const card = screen.getByRole("button");
    expect(card).toHaveAttribute("aria-selected", "true");
  });
});
