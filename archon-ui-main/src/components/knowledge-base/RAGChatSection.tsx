import { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Sparkles, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { useToast } from '../../contexts/ToastContext';
import io, { Socket } from 'socket.io-client';
import { API_BASE_URL } from '../../config/api';

interface Message {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: string;
  agent_type?: string;
  isStreaming?: boolean;
}

export const RAGChatSection = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  // Initialize chat session and socket connection
  useEffect(() => {
    const initChat = async () => {
      try {
        // Create a new chat session
        const response = await fetch(`${API_BASE_URL}/agent-chat/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_type: 'rag' }),
        });

        if (!response.ok) throw new Error('Failed to create chat session');
        
        const data = await response.json();
        setSessionId(data.session_id);

        // Connect to Socket.IO
        const socketUrl = API_BASE_URL.replace('/api', '');
        const newSocket = io(socketUrl, {
          path: '/socket.io/',
          transports: ['websocket', 'polling'],
        });

        newSocket.on('connect', () => {
          console.log('Connected to chat server');
          // Join the chat room
          if (data.session_id) {
            newSocket.emit('join_chat', { session_id: data.session_id });
          }
        });

        newSocket.on('message', (data: { type: string; data: Message }) => {
          if (data.data.sender === 'agent') {
            setMessages(prev => [...prev, data.data]);
            setStreamingContent('');
          }
        });

        newSocket.on('stream_chunk', (data: { content: string }) => {
          setStreamingContent(prev => prev + data.content);
        });

        newSocket.on('typing', (data: { is_typing: boolean }) => {
          setIsTyping(data.is_typing);
        });

        newSocket.on('stream_complete', () => {
          setIsTyping(false);
          setLoading(false);
        });

        newSocket.on('error', (data: { error: string }) => {
          showToast(data.error, 'error');
          setLoading(false);
          setIsTyping(false);
        });

        setSocket(newSocket);
      } catch (error) {
        console.error('Failed to initialize chat:', error);
        showToast('Failed to connect to chat service', 'error');
      }
    };

    initChat();

    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const sendMessage = async () => {
    if (!input.trim() || !sessionId || !socket || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      content: input,
      sender: 'user',
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setStreamingContent('');

    // Send message via Socket.IO
    socket.emit('chat_message', {
      session_id: sessionId,
      message: input,
      context: {},
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="mb-8">
      <Card className="p-6 bg-gradient-to-r from-purple-500/5 to-blue-500/5 border-purple-500/20">
        <div className="flex items-center gap-3 mb-4">
          <Sparkles className="w-5 h-5 text-purple-500" />
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
            RAG Knowledge Chat
          </h3>
          <Badge color="green" variant="outline" size="sm">
            Connected
          </Badge>
        </div>

        {/* Chat Messages */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 mb-4 h-96 overflow-y-auto p-4">
          {messages.length === 0 && !streamingContent ? (
            <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
              <div className="text-center">
                <Bot className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>Start a conversation about your knowledge base</p>
                <p className="text-sm mt-1">Ask questions and get AI-powered answers</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <AnimatePresence>
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className={`flex gap-3 ${
                      message.sender === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {message.sender === 'agent' && (
                      <div className="flex-shrink-0">
                        <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center">
                          <Bot className="w-5 h-5 text-white" />
                        </div>
                      </div>
                    )}
                    
                    <div
                      className={`max-w-[70%] rounded-lg p-3 ${
                        message.sender === 'user'
                          ? 'bg-blue-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      <p className={`text-xs mt-1 ${
                        message.sender === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
                      }`}>
                        {new Date(message.timestamp).toLocaleTimeString()}
                      </p>
                    </div>

                    {message.sender === 'user' && (
                      <div className="flex-shrink-0">
                        <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center">
                          <User className="w-5 h-5 text-white" />
                        </div>
                      </div>
                    )}
                  </motion.div>
                ))}

                {/* Streaming message */}
                {streamingContent && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-3 justify-start"
                  >
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center">
                        <Bot className="w-5 h-5 text-white" />
                      </div>
                    </div>
                    <div className="max-w-[70%] rounded-lg p-3 bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                      <p className="whitespace-pre-wrap break-words">{streamingContent}</p>
                    </div>
                  </motion.div>
                )}

                {/* Typing indicator */}
                {isTyping && !streamingContent && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-3 justify-start"
                  >
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center">
                        <Bot className="w-5 h-5 text-white" />
                      </div>
                    </div>
                    <div className="max-w-[70%] rounded-lg p-3 bg-gray-100 dark:bg-gray-800">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="flex gap-3">
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask about your knowledge base..."
            accentColor="purple"
            disabled={loading || !sessionId}
          />
          <Button
            onClick={sendMessage}
            variant="primary"
            accentColor="purple"
            disabled={loading || !input.trim() || !sessionId}
            className="shadow-lg shadow-purple-500/20"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>

        {!sessionId && (
          <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Connecting to chat service...
          </div>
        )}
      </Card>
    </div>
  );
};