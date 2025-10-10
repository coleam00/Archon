import { motion } from "framer-motion";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Send } from "lucide-react";
import { useAgentChat } from "./hooks/useAgentChat";
import { useEffect, useRef } from "react";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export default function AgentChatPage() {
  const { messages, inputValue, setInputValue, handleSendMessage, isLoading } = useAgentChat();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Automatically scroll to the bottom when new messages are added
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="flex flex-col h-[calc(100vh-120px)] max-w-4xl mx-auto p-4"
    >
      {/* Message Display Area */}
      <motion.div
        variants={itemVariants}
        className="flex-grow overflow-y-auto p-4 rounded-lg bg-gray-800/20"
      >
        <div className="space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.sender === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-lg px-4 py-2 rounded-lg break-words ${
                  message.sender === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-700 text-gray-200"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </motion.div>

      {/* Input Form */}
      <motion.div variants={itemVariants} className="mt-4">
        <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
          <Input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Tell me what you want to build..."
            className="flex-grow bg-gray-800/50 border-gray-600 focus:ring-blue-500"
            disabled={isLoading}
          />
          <Button type="submit" variant="default" size="icon" disabled={!inputValue.trim() || isLoading}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </motion.div>
    </motion.div>
  );
}
