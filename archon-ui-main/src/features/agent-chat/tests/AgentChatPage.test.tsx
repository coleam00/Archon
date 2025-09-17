import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AgentChatPage from "../AgentChatPage";
import { vi } from "vitest";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Send: () => <div data-testid="send-icon" />,
}));

// Mock the hook used by the component
vi.mock("../hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    messages: [{ id: "1", content: "Test message", sender: "agent", timestamp: "" }],
    inputValue: "",
    setInputValue: vi.fn(),
    handleSendMessage: vi.fn(),
    isLoading: false,
  }),
}));

const queryClient = new QueryClient();

describe("AgentChatPage", () => {
  it("renders the chat interface", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AgentChatPage />
      </QueryClientProvider>
    );

    // Check for the input placeholder
    expect(screen.getByPlaceholderText("Tell me what you want to build...")).toBeInTheDocument();

    // Check if the test message is displayed
    expect(screen.getByText("Test message")).toBeInTheDocument();
  });
});
