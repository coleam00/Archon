import { renderHook, waitFor, act } from "@testing-library/react";
import { vi } from "vitest";
import { useAgentChat } from "../useAgentChat";
import { agentChatService } from "../../services/agentChatService";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Mock the agentChatService
vi.mock("../../services/agentChatService", () => ({
  agentChatService: {
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    getMessages: vi.fn(),
  },
}));

// Wrapper component to provide React Query context
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // a short retry delay for tests
      retryDelay: 10,
    },
  },
});
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe("useAgentChat", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    queryClient.clear(); // Clear the query cache
  });

  it("should create a session on initial render", async () => {
    const mockSession = { session_id: "test-session-123" };
    (agentChatService.createSession as vi.Mock).mockResolvedValue(mockSession);
    (agentChatService.getMessages as vi.Mock).mockResolvedValue([]); // Mock getMessages

    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await waitFor(() => {
      expect(agentChatService.createSession).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(result.current.messages.length).toBe(1);
      expect(result.current.messages[0].content).toContain("Session created");
    });
  });

  it("should send a message and optimistically update the UI", async () => {
    const mockSession = { session_id: "test-session-123" };
    (agentChatService.createSession as vi.Mock).mockResolvedValue(mockSession);
    (agentChatService.sendMessage as vi.Mock).mockResolvedValue({ status: "sent" });
    (agentChatService.getMessages as vi.Mock).mockResolvedValue([]); // Mock getMessages

    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await waitFor(() => {
      expect(result.current.messages[0].content).toContain("Session created");
    });

    const formEvent = { preventDefault: vi.fn() } as unknown as React.FormEvent;

    // Use act to wrap state updates
    act(() => {
      result.current.setInputValue("Hello, world!");
    });

    // Use act to wrap the event handler that causes mutation
    await act(async () => {
      result.current.handleSendMessage(formEvent);
    });

    expect(agentChatService.sendMessage).toHaveBeenCalledWith("test-session-123", "Hello, world!");

    // Check for optimistic update
    expect(result.current.messages.some(m => m.sender === 'user' && m.content === 'Hello, world!')).toBe(true);
  });
});
