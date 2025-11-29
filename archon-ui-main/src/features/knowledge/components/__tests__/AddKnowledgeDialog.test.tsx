/**
 * Tests for AddKnowledgeDialog component
 *
 * Comprehensive tests for crawl and upload functionality,
 * GitHub auto-configuration, pattern filtering, and form validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AddKnowledgeDialog } from "../AddKnowledgeDialog";
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

// Mock hooks
const mockCrawlMutation = {
  mutateAsync: vi.fn(),
  isPending: false,
};

const mockUploadMutation = {
  mutateAsync: vi.fn(),
  isPending: false,
};

vi.mock("../../hooks", () => ({
  useCrawlUrl: () => mockCrawlMutation,
  useUploadDocument: () => mockUploadMutation,
}));

// Mock lucide-react icons - use importOriginal to preserve all icons
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    // All original icons are preserved
    // Can override specific icons here if needed for test assertions
  };
});

describe("AddKnowledgeDialog", () => {
  let queryClient: QueryClient;
  let mockOnOpenChange: ReturnType<typeof vi.fn>;
  let mockOnSuccess: ReturnType<typeof vi.fn>;
  let mockOnCrawlStarted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockOnOpenChange = vi.fn();
    mockOnSuccess = vi.fn();
    mockOnCrawlStarted = vi.fn();

    mockShowToast.mockClear();
    mockCrawlMutation.mutateAsync.mockClear();
    mockUploadMutation.mutateAsync.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderDialog = (overrides = {}) => {
    const props = {
      open: true,
      onOpenChange: mockOnOpenChange,
      onSuccess: mockOnSuccess,
      onCrawlStarted: mockOnCrawlStarted,
      ...overrides,
    };

    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AddKnowledgeDialog {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    );
  };

  describe("Basic Rendering", () => {
    it("renders the dialog when open", () => {
      renderDialog();
      expect(screen.getByText("Add Knowledge")).toBeInTheDocument();
    });

    it("does not render when closed", () => {
      renderDialog({ open: false });
      expect(screen.queryByText("Add Knowledge")).not.toBeInTheDocument();
    });

    it("shows both crawl and upload tabs", () => {
      renderDialog();
      expect(screen.getByText("Crawl Website")).toBeInTheDocument();
      expect(screen.getByText("Upload Document")).toBeInTheDocument();
    });
  });

  describe("Crawl Tab - Basic Functionality", () => {
    it("renders URL input field", () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      expect(urlInput).toBeInTheDocument();
    });

    it("renders pattern input field", () => {
      renderDialog();
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      expect(patternInput).toBeInTheDocument();
    });

    it("renders review links checkbox", () => {
      renderDialog();
      const checkbox = screen.getByLabelText(/Review discovered links/i);
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked(); // Default enabled
    });

    it("disables start button when URL is empty", () => {
      renderDialog();
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });
      expect(startButton).toBeDisabled();
    });

    it("enables start button when URL is provided", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.change(urlInput, { target: { value: "https://example.com" } });

      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
    });
  });

  describe("GitHub Auto-Configuration", () => {
    it("auto-populates patterns for GitHub URLs", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);

      fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo" } });

      await waitFor(() => {
        expect(patternInput).toHaveValue("**/tree/**, **/blob/**");
      });
    });

    it("sets depth to 3 for GitHub repos", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);

      fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo" } });

      await waitFor(() => {
        // Check that max depth was updated to 3
        // LevelSelector is a custom component, check the text content
        expect(screen.getByText(/Level 3/i)).toBeInTheDocument();
      });
    });

    it("adds 'GitHub Repo' tag automatically", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);

      fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo" } });

      await waitFor(() => {
        expect(screen.getByText("GitHub Repo")).toBeInTheDocument();
      });
    });

    it("shows GitHub detection notice", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);

      fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo" } });

      await waitFor(() => {
        expect(screen.getByText(/GitHub Repository Detected/i)).toBeInTheDocument();
      });
    });

    it("does not override manually entered patterns", async () => {
      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);

      // Set custom pattern first
      fireEvent.change(patternInput, { target: { value: "custom/**" } });

      // Then change to GitHub URL
      fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo" } });

      await waitFor(() => {
        // Should keep custom pattern, not override
        expect(patternInput).toHaveValue("custom/**");
      });
    });
  });

  describe("Crawl Submission - Link Review Disabled", () => {
    it("calls crawl mutation with correct data", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      // Disable review
      fireEvent.click(reviewCheckbox);

      // Enter URL
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });

      // Submit
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://example.com",
            knowledge_type: "technical",
            max_depth: 2,
            skip_link_review: true,
          })
        );
      });
    });

    it("includes patterns in request when provided", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox); // Disable review
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.change(patternInput, { target: { value: "**/en/**, !**/api/**" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            url_include_patterns: ["**/en/**"],
            url_exclude_patterns: ["**/api/**"],
          })
        );
      });
    });

    it("shows success toast after crawl starts", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith("Crawl started successfully", "success");
      });
    });

    it("calls onCrawlStarted callback with progressId", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockOnCrawlStarted).toHaveBeenCalledWith("test-123");
      });
    });

    it("shows error toast on crawl failure", async () => {
      mockCrawlMutation.mutateAsync.mockRejectedValue(new Error("Network error"));

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith("Network error", "error");
      });
    });
  });

  describe("Crawl Submission - Link Review Enabled", () => {
    it("calls preview endpoint when review is enabled", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");
      const mockPreviewData: LinkPreviewResponse = {
        is_link_collection: false,
        collection_type: null,
        source_url: "https://example.com",
        total_links: 0,
        matching_links: 0,
        links: [],
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(callAPIWithETag).toHaveBeenCalledWith("/crawl/preview-links", expect.any(Object));
      });
    });

    it("proceeds with normal crawl for non-link collections", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");
      const mockPreviewData: LinkPreviewResponse = {
        is_link_collection: false,
        collection_type: null,
        source_url: "https://example.com",
        total_links: 0,
        matching_links: 0,
        links: [],
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalled();
        expect(mockShowToast).toHaveBeenCalledWith("Crawl started successfully", "success");
      });
    });

    it("shows review modal for link collections", async () => {
      const { callAPIWithETag } = await import("@/features/shared/api/apiClient");
      const mockPreviewData: LinkPreviewResponse = {
        is_link_collection: true,
        collection_type: "llms-txt",
        source_url: "https://example.com/llms.txt",
        total_links: 5,
        matching_links: 3,
        links: [
          { url: "https://example.com/page1", text: "Page 1", path: "/page1", matches_filter: true },
        ],
      };

      vi.mocked(callAPIWithETag).mockResolvedValue(mockPreviewData);

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.click(startButton);

      // Should NOT proceed with crawl immediately
      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).not.toHaveBeenCalled();
      });
    });
  });

  describe("Upload Tab", () => {
    it("switches to upload tab", () => {
      renderDialog();
      const uploadTab = screen.getByText("Upload Document");
      fireEvent.click(uploadTab);

      expect(screen.getByText(/Click to browse/i)).toBeInTheDocument();
    });

    it("disables upload button when no file selected", () => {
      renderDialog();
      const uploadTab = screen.getByText("Upload Document");
      fireEvent.click(uploadTab);

      const uploadButtons = screen.getAllByRole("button");
      const uploadButton = uploadButtons.find(btn => btn.textContent?.includes("Upload Document"));
      expect(uploadButton).toBeDisabled();
    });

    it("shows file name after selection", async () => {
      renderDialog();
      const uploadTab = screen.getByText("Upload Document");
      fireEvent.click(uploadTab);

      await waitFor(() => {
        expect(screen.getByText(/Click to browse/i)).toBeInTheDocument();
      });

      // Find the file input after tab is rendered
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const file = new File(["content"], "test.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText("test.pdf")).toBeInTheDocument();
      });
    });

    it("calls upload mutation with correct data", async () => {
      mockUploadMutation.mutateAsync.mockResolvedValue({ progressId: "upload-123" });

      renderDialog();
      const uploadTab = screen.getByText("Upload Document");
      fireEvent.click(uploadTab);

      await waitFor(() => {
        expect(screen.getByText(/Click to browse/i)).toBeInTheDocument();
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const file = new File(["content"], "test.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        const uploadButtons = screen.getAllByRole("button");
        const uploadButton = uploadButtons.find(btn => btn.textContent?.includes("Upload Document"));
        expect(uploadButton).not.toBeDisabled();
        fireEvent.click(uploadButton!);
      });

      await waitFor(() => {
        expect(mockUploadMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            file,
            metadata: expect.objectContaining({
              knowledge_type: "technical",
            }),
          })
        );
      });
    });

    it("shows success message after upload", async () => {
      mockUploadMutation.mutateAsync.mockResolvedValue({ progressId: "upload-123" });

      renderDialog();
      const uploadTab = screen.getByText("Upload Document");
      fireEvent.click(uploadTab);

      await waitFor(() => {
        expect(screen.getByText(/Click to browse/i)).toBeInTheDocument();
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const file = new File(["content"], "test.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        const uploadButtons = screen.getAllByRole("button");
        const uploadButton = uploadButtons.find(btn => btn.textContent?.includes("Upload Document"));
        expect(uploadButton).not.toBeDisabled();
        fireEvent.click(uploadButton!);
      });

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.stringContaining("Upload started"),
          "info"
        );
      });
    });
  });

  describe("buildCrawlRequest Helper", () => {
    it("correctly parses include patterns", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.change(patternInput, { target: { value: "**/docs/**, **/api/**" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            url_include_patterns: ["**/docs/**", "**/api/**"],
          })
        );
      });
    });

    it("correctly parses exclude patterns with ! prefix", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.change(patternInput, { target: { value: "!**/old/**, !**/deprecated/**" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            url_exclude_patterns: ["**/old/**", "**/deprecated/**"],
          })
        );
      });
    });

    it("handles mixed include and exclude patterns", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.change(patternInput, { target: { value: "**/docs/**, !**/api/**" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockCrawlMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            url_include_patterns: ["**/docs/**"],
            url_exclude_patterns: ["**/api/**"],
          })
        );
      });
    });
  });

  describe("Form Reset", () => {
    it("resets form after successful crawl", async () => {
      mockCrawlMutation.mutateAsync.mockResolvedValue({ progressId: "test-123" });

      renderDialog();
      const urlInput = screen.getByPlaceholderText(/https:\/\/docs.example.com/i);
      const patternInput = screen.getByPlaceholderText(/e.g., \*\*\/en\/\*\*/i);
      const reviewCheckbox = screen.getByLabelText(/Review discovered links/i);
      const startButton = screen.getByRole("button", { name: /Start Crawling/i });

      fireEvent.click(reviewCheckbox);
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      fireEvent.change(patternInput, { target: { value: "**/test/**" } });
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });
  });
});
