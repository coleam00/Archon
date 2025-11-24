/**
 * Tests for LinkReviewModal component
 *
 * Tests loading states, error handling, accessibility, and user interactions
 * for the link review feature added in PR #847.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LinkReviewModal } from "../LinkReviewModal";
import type { LinkPreviewResponse } from "../../types";

// Mock the API client
vi.mock("@/features/shared/api/apiClient", () => ({
  callAPIWithETag: vi.fn(),
}));

// Mock toast hook
const mockShowToast = vi.fn();
vi.mock("@/features/shared/hooks/useToast", () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

// Mock lucide-react icons (including X for dialog close button)
vi.mock("lucide-react", () => ({
  Loader2: ({ className }: { className?: string }) => (
    <span className={className} data-testid="loader2-icon" />
  ),
  Filter: ({ className }: { className?: string }) => (
    <span className={className} data-testid="filter-icon" />
  ),
  CheckCircle2: ({ className }: { className?: string }) => (
    <span className={className} data-testid="check-circle-icon" />
  ),
  XCircle: ({ className }: { className?: string }) => (
    <span className={className} data-testid="x-circle-icon" />
  ),
  X: ({ className }: { className?: string }) => (
    <span className={className} data-testid="x-icon" />
  ),
}));

describe("LinkReviewModal", () => {
  let queryClient: QueryClient;
  let mockPreviewData: LinkPreviewResponse;
  let mockOnProceed: ReturnType<typeof vi.fn>;
  let mockOnCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create fresh QueryClient for each test
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    // Sample preview data
    mockPreviewData = {
      is_link_collection: true,
      collection_type: "llms-txt",
      source_url: "https://docs.example.com/llms.txt",
      total_links: 10,
      matching_links: 5,
      links: [
        {
          url: "https://docs.example.com/en/page1",
          text: "Introduction",
          path: "/en/page1",
          matches_filter: true,
        },
        {
          url: "https://docs.example.com/fr/page2",
          text: "Guide",
          path: "/fr/page2",
          matches_filter: false,
        },
        {
          url: "https://docs.example.com/en/page3",
          text: "Tutorial",
          path: "/en/page3",
          matches_filter: true,
        },
      ],
    };

    mockOnProceed = vi.fn();
    mockOnCancel = vi.fn();

    // Clear mocks
    mockShowToast.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderModal = (overrides = {}) => {
    const props = {
      open: true,
      previewData: mockPreviewData,
      initialIncludePatterns: [],
      initialExcludePatterns: [],
      onProceed: mockOnProceed,
      onCancel: mockOnCancel,
      ...overrides,
    };

    return render(
      <QueryClientProvider client={queryClient}>
        <LinkReviewModal {...props} />
      </QueryClientProvider>
    );
  };

  describe("Loading States", () => {
    it("shows loading state when applying filters", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      // Mock API to never resolve (simulates loading)
      vi.mocked(callAPIWithETag).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      // Should show loading text and spinner
      await waitFor(() => {
        expect(screen.getByText("Applying...")).toBeInTheDocument();
      });

      // Button should be disabled during loading
      expect(applyButton).toBeDisabled();
    });

    it("re-enables button after filters applied successfully", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.getByText("Apply Filters")).toBeInTheDocument();
      });

      // Button should be enabled again
      expect(applyButton).not.toBeDisabled();
    });

    it("re-enables button after filter error", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      vi.mocked(callAPIWithETag).mockRejectedValue(new Error("Network error"));

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      // Wait for error handling
      await waitFor(() => {
        expect(screen.getByText("Apply Filters")).toBeInTheDocument();
      });

      // Button should be enabled again after error
      expect(applyButton).not.toBeDisabled();
    });
  });

  describe("Toast Notifications", () => {
    it("shows success toast after applying filters", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.stringContaining("Filters applied"),
          "success"
        );
      });
    });

    it("shows error toast on filter failure", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      vi.mocked(callAPIWithETag).mockRejectedValue(new Error("Network error"));

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.stringContaining("Network error"),
          "error"
        );
      });
    });

    it("shows generic error message for unknown errors", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      // Reject with non-Error object
      vi.mocked(callAPIWithETag).mockRejectedValue("Something went wrong");

      renderModal();

      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to apply filters"),
          "error"
        );
      });
    });
  });

  describe("Event Handling - Double Fire Prevention", () => {
    it("toggles checkbox only once when clicking checkbox directly", () => {
      renderModal();

      // Get first checkbox (should be checked due to matches_filter: true)
      const checkboxes = screen.getAllByRole("checkbox");
      const firstCheckbox = checkboxes[0] as HTMLInputElement;

      const initialState = firstCheckbox.checked;
      expect(initialState).toBe(true); // First link has matches_filter: true

      // Trigger change event directly on the checkbox
      fireEvent.change(firstCheckbox, { target: { checked: !initialState } });

      // Should toggle exactly once
      expect(firstCheckbox.checked).toBe(!initialState);
    });

    it("does not double-toggle when clicking parent div after fixing stopPropagation", () => {
      renderModal();

      const checkboxes = screen.getAllByRole("checkbox");
      const firstCheckbox = checkboxes[0] as HTMLInputElement;
      const initialState = firstCheckbox.checked;

      // Find parent div by looking for the text near the checkbox
      const parentDiv = screen.getByText("Introduction").closest("div");

      if (parentDiv) {
        fireEvent.click(parentDiv);
      }

      // After fix, clicking parent should toggle once (not twice)
      expect(firstCheckbox.checked).toBe(!initialState);
    });
  });

  describe("Accessibility", () => {
    it("has accessible search input with aria-label", () => {
      renderModal();

      const searchInput = screen.getByLabelText("Search links");
      expect(searchInput).toBeInTheDocument();
      expect(searchInput).toHaveAttribute("type", "text");
      expect(searchInput).toHaveAttribute("placeholder", "Search links...");
    });

    it("has proper checkbox roles", () => {
      renderModal();

      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes.length).toBeGreaterThan(0);

      checkboxes.forEach((checkbox) => {
        expect(checkbox).toHaveAttribute("type", "checkbox");
      });
    });

    it("shows collection type in title", () => {
      renderModal();

      expect(screen.getByText(/Review Links - llms-txt/)).toBeInTheDocument();
    });

    it("displays link count information", () => {
      renderModal();

      // Should show selected count and total
      expect(screen.getByText(/2 of 3 links selected/)).toBeInTheDocument();
    });
  });

  describe("Pattern Filtering UI", () => {
    it('shows unified pattern field with "!" exclusion hint', () => {
      renderModal();

      expect(screen.getByText(/URL Patterns.*use ! to exclude/)).toBeInTheDocument();
      expect(screen.getByLabelText(/URL Patterns/)).toBeInTheDocument();
    });

    it("accepts pattern input changes", () => {
      renderModal();

      const patternInput = screen.getByLabelText(/URL Patterns/);
      fireEvent.change(patternInput, { target: { value: "**/en/**, !**/api/**" } });

      expect(patternInput).toHaveValue("**/en/**, !**/api/**");
    });

    it("sends patterns to API when applying filters", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);

      renderModal();

      // Enter unified pattern (include and exclude in one field)
      const patternInput = screen.getByLabelText(/URL Patterns/);
      fireEvent.change(patternInput, { target: { value: "**/en/**, !**/fr/**" } });

      // Apply filters
      const applyButton = screen.getByText("Apply Filters");
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(callAPIWithETag).toHaveBeenCalledWith(
          "/crawl/preview-links",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("**/en/**"),
          })
        );
      });
    });
  });

  describe("Bulk Selection Operations", () => {
    it("selects all links when clicking Select All", () => {
      renderModal();

      const selectAllButton = screen.getByText("Select All");
      fireEvent.click(selectAllButton);

      const checkboxes = screen.getAllByRole("checkbox");
      checkboxes.forEach((checkbox) => {
        expect(checkbox).toBeChecked();
      });
    });

    it("deselects all links when clicking Deselect All", () => {
      renderModal();

      // First select all
      const selectAllButton = screen.getByText("Select All");
      fireEvent.click(selectAllButton);

      // Then deselect all
      const deselectAllButton = screen.getByText("Deselect All");
      fireEvent.click(deselectAllButton);

      const checkboxes = screen.getAllByRole("checkbox");
      checkboxes.forEach((checkbox) => {
        expect(checkbox).not.toBeChecked();
      });
    });

    it("inverts selection when clicking Invert", () => {
      renderModal();

      // Get initial states
      const checkboxes = screen.getAllByRole("checkbox");
      const initialStates = Array.from(checkboxes).map((cb) => (cb as HTMLInputElement).checked);

      // Click invert
      const invertButton = screen.getByText("Invert");
      fireEvent.click(invertButton);

      // Check that all states are inverted
      checkboxes.forEach((checkbox, index) => {
        expect((checkbox as HTMLInputElement).checked).toBe(!initialStates[index]);
      });
    });
  });

  describe("Search Functionality", () => {
    it("filters links based on search term", () => {
      renderModal();

      const searchInput = screen.getByLabelText("Search links");

      // Search for "Tutorial"
      fireEvent.change(searchInput, { target: { value: "Tutorial" } });

      // Should show Tutorial but not Introduction or Guide
      expect(screen.getByText("Tutorial")).toBeInTheDocument();
      expect(screen.queryByText("Introduction")).not.toBeInTheDocument();
    });

    it("shows all links when search is cleared", () => {
      renderModal();

      const searchInput = screen.getByLabelText("Search links");

      // Enter search term
      fireEvent.change(searchInput, { target: { value: "Tutorial" } });

      // Clear search
      fireEvent.change(searchInput, { target: { value: "" } });

      // All links should be visible again
      expect(screen.getByText("Tutorial")).toBeInTheDocument();
      expect(screen.getByText("Introduction")).toBeInTheDocument();
      expect(screen.getByText("Guide")).toBeInTheDocument();
    });

    it("shows empty state when no links match search", () => {
      renderModal();

      const searchInput = screen.getByLabelText("Search links");

      // Search for non-existent term
      fireEvent.change(searchInput, { target: { value: "NonExistentPage" } });

      expect(screen.getByText(/No links found matching your search/)).toBeInTheDocument();
    });
  });

  describe("Proceed Action", () => {
    it("calls onProceed with selected URLs", () => {
      renderModal();

      // Select first link
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);

      // Click proceed
      const proceedButton = screen.getByText(/Proceed with/);
      fireEvent.click(proceedButton);

      // Should call with array of selected URLs
      expect(mockOnProceed).toHaveBeenCalledWith(expect.any(Array));
      expect(mockOnProceed).toHaveBeenCalledTimes(1);
    });

    it("disables proceed button when no links selected", () => {
      renderModal();

      // Deselect all links
      const deselectAllButton = screen.getByText("Deselect All");
      fireEvent.click(deselectAllButton);

      const proceedButton = screen.getByText(/Proceed with/);
      expect(proceedButton).toBeDisabled();
    });

    it("shows correct count in proceed button text", () => {
      renderModal();

      // Initial state: 2 links auto-selected (matches_filter: true)
      expect(screen.getByText("Proceed with 2 Selected Links")).toBeInTheDocument();

      // Select all
      const selectAllButton = screen.getByText("Select All");
      fireEvent.click(selectAllButton);

      expect(screen.getByText("Proceed with 3 Selected Links")).toBeInTheDocument();
    });
  });

  describe("Cancel Action", () => {
    it("calls onCancel when clicking Cancel button", () => {
      renderModal();

      const cancelButton = screen.getByText("Cancel");
      fireEvent.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("Initial State", () => {
    it("auto-selects links that match filters", () => {
      renderModal();

      // 2 links have matches_filter: true in mockPreviewData
      const checkboxes = screen.getAllByRole("checkbox");
      const checkedCount = Array.from(checkboxes).filter((cb) => (cb as HTMLInputElement).checked).length;

      expect(checkedCount).toBe(2);
    });

    it("displays source URL", () => {
      renderModal();

      expect(screen.getByText(mockPreviewData.source_url)).toBeInTheDocument();
    });

    it("displays collection type", () => {
      renderModal();

      expect(screen.getByText(/llms-txt/)).toBeInTheDocument();
    });
  });

  describe("Tailwind Styling", () => {
    it("uses Tailwind classes instead of inline styles", () => {
      renderModal();

      // The modal content should use h-[90vh] class, not inline style
      const dialogContent = document.querySelector('[role="dialog"]');
      expect(dialogContent).toBeTruthy();

      // Check that inline height style is not present
      const elementsWithInlineHeight = document.querySelectorAll('[style*="height"]');
      expect(elementsWithInlineHeight.length).toBe(0);
    });
  });
});
