import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentChatService, ChatMessage } from "../services/agentChatService";
import { useSmartPolling } from "../../ui/hooks/useSmartPolling";

// Define query keys for agent chat
const agentChatKeys = {
  all: ["agent-chat"] as const,
  session: (sessionId: string) => [...agentChatKeys.all, sessionId] as const,
  messages: (sessionId: string) => [...agentChatKeys.session(sessionId), "messages"] as const,
};

export const useAgentChat = () => {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");

  // Create a session when the hook is first used
  useEffect(() => {
    const createNewSession = async () => {
      try {
        const data = await agentChatService.createSession();
        setSessionId(data.session_id);
        setMessages([
          {
            id: "initial-ready",
            content: "Session created. How can I help you build today?",
            sender: "agent",
            timestamp: new Date().toISOString(),
          },
        ]);
      } catch (error) {
        setMessages([
          {
            id: "initial-error",
            content: "Failed to create a chat session. Please try refreshing the page.",
            sender: "agent",
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    };
    createNewSession();
  }, []);

  // Polling for new messages
  const { refetchInterval } = useSmartPolling(3000); // Poll every 3 seconds
  useQuery({
    queryKey: agentChatKeys.messages(sessionId!),
    queryFn: () => agentChatService.getMessages(sessionId!),
    enabled: !!sessionId,
    refetchInterval,
    onSuccess: (newMessages) => {
      if (newMessages && newMessages.length > 0) {
        setMessages((currentMessages) => {
          const currentMessageIds = new Set(currentMessages.map((m) => m.id));
          const incomingMessages = newMessages.filter((m) => !currentMessageIds.has(m.id));
          if (incomingMessages.length > 0) {
            return [...currentMessages, ...incomingMessages].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
          }
          return currentMessages;
        });
      }
    },
  });

  // Mutation for sending a message
  const sendMessageMutation = useMutation({
    mutationFn: (messageText: string) => {
      if (!sessionId) throw new Error("Session ID is not available.");
      return agentChatService.sendMessage(sessionId, messageText);
    },
    onMutate: async (messageText: string) => {
      // Optimistically add the user's message to the UI
      const userMessage: ChatMessage = {
        id: `temp-${Date.now()}`,
        content: messageText,
        sender: "user",
        timestamp: new Date().toISOString(),
      };
      setMessages((prevMessages) => [...prevMessages, userMessage]);
      setInputValue("");
    },
    onSuccess: () => {
      // When the message is successfully sent, invalidate the messages query to trigger a refetch
      queryClient.invalidateQueries({ queryKey: agentChatKeys.messages(sessionId!) });
    },
    onError: (error) => {
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        content: `Error sending message: ${error.message}`,
        sender: "agent",
        timestamp: new Date().toISOString(),
      };
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
    },
  });

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() === "") return;
    sendMessageMutation.mutate(inputValue);
  };

  return {
    messages,
    inputValue,
    setInputValue,
    handleSendMessage,
    isLoading: sendMessageMutation.isPending,
  };
};
