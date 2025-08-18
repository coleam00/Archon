import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Send, Bot, User, Sparkles, Loader2, X, MessageSquare, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
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
  context?: any;
}

interface IntegratedRAGChatProps {
  isExpanded: boolean;
  onToggleExpand: () => void;
  className?: string;
}

export interface IntegratedRAGChatRef {
  askAboutItem: (item: any) => void;
  sendMessage: (message: string, context?: any) => void;
}

export const IntegratedRAGChat = forwardRef<IntegratedRAGChatRef, IntegratedRAGChatProps>(
  ({ isExpanded, onToggleExpand, className = '' }, ref) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isTyping, setIsTyping] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const { showToast } = useToast();

    // Initialize chat session and socket connection
    useEffect(() => {
      const initChat = async () => {
        try {
          const response = await fetch(`${API_BASE_URL}/agent-chat/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_type: 'rag' }),
          });

          if (!response.ok) throw new Error('Failed to create chat session');
          
          const data = await response.json();
          setSessionId(data.session_id);

          const socketUrl = API_BASE_URL.replace('/api', '');
          const newSocket = io(socketUrl, {
            path: '/socket.io/',
            transports: ['websocket', 'polling'],
          });

          newSocket.on('connect', () => {
            console.log('Connected to chat server');
            if (data.session_id) {
              newSocket.emit('join_chat', { session_id: data.session_id });
            }
          });

          newSocket.on('message', (data: { type: string; data: Message }) => {
            if (data.data.sender === 'agent') {
              setMessages(prev => [...prev, data.data]);
              setStreamingContent('');
              // Increment unread count if chat is collapsed
              if (!isExpanded) {
                setUnreadCount(prev => prev + 1);
              }
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

    // Clear unread count when expanded
    useEffect(() => {
      if (isExpanded) {
        setUnreadCount(0);
      }
    }, [isExpanded]);

    // Auto-scroll to bottom
    useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streamingContent]);

    const sendMessage = async (message?: string, context?: any) => {
      const messageToSend = message || input;
      if (!messageToSend.trim() || !sessionId || !socket || loading) return;

      const userMessage: Message = {
        id: Date.now().toString(),
        content: messageToSend,
        sender: 'user',
        timestamp: new Date().toISOString(),
        context,
      };

      setMessages(prev => [...prev, userMessage]);
      if (!message) setInput('');
      setLoading(true);
      setStreamingContent('');

      socket.emit('chat_message', {
        session_id: sessionId,
        message: messageToSend,
        context: context || {},
      });
    };

    const askAboutItem = (item: any) => {
      const message = `Tell me about "${item.title}"`;
      const context = {
        source_id: item.source_id,
        url: item.url,
        metadata: item.metadata,
      };
      sendMessage(message, context);
      
      // Expand chat if collapsed
      if (!isExpanded) {
        onToggleExpand();
      }
      
      // Focus input after asking
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      askAboutItem,
      sendMessage,
    }));

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    const toggleFullscreen = () => {
      setIsFullscreen(!isFullscreen);
    };

    return (
      <AnimatePresence mode="wait">
        <motion.div
          initial={{ width: isExpanded ? 0 : 80 }}
          animate={{ 
            width: isExpanded ? (isFullscreen ? '100%' : 420) : 80,
            height: isFullscreen ? '100vh' : 'auto'
          }}
          exit={{ width: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className={`${isFullscreen ? 'fixed inset-0 z-50' : 'relative'} ${className}`}
        >
          <Card className={`h-full flex flex-col bg-gradient-to-br from-purple-500/5 via-blue-500/5 to-purple-500/5 border-purple-500/20 ${isFullscreen ? '' : 'rounded-lg'}`}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              {isExpanded ? (
                <>
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-purple-500" />
                    <h3 className="font-semibold text-gray-800 dark:text-white">RAG Assistant</h3>
                    <Badge color="green" variant="outline" size="sm">Online</Badge>
                    {unreadCount > 0 && (
                      <Badge color="red" variant="solid" size="sm">{unreadCount}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={toggleFullscreen}
                      variant="ghost"
                      size="sm"
                      accentColor="gray"
                    >
                      {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </Button>
                    <Button
                      onClick={onToggleExpand}
                      variant="ghost"
                      size="sm"
                      accentColor="gray"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <div className="w-full flex flex-col items-center gap-2">
                  <Button
                    onClick={onToggleExpand}
                    variant="ghost"
                    className="p-2"
                    accentColor="purple"
                  >
                    <MessageSquare className="w-5 h-5" />
                  </Button>
                  {unreadCount > 0 && (
                    <Badge color="red" variant="solid" size="sm">{unreadCount}</Badge>
                  )}
                  <span className="text-xs text-gray-500 dark:text-gray-400 writing-mode-vertical">Chat</span>
                </div>
              )}
            </div>

            {/* Chat Content - Only visible when expanded */}
            {isExpanded && (
              <>
                {/* Messages Area */}
                <div className={`flex-1 overflow-y-auto p-4 ${isFullscreen ? 'max-h-[calc(100vh-180px)]' : 'h-[500px]'}`}>
                  {messages.length === 0 && !streamingContent ? (
                    <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
                      <div className="text-center">
                        <Bot className="w-12 h-12 mx-auto mb-3 opacity-50" />
                        <p className="font-medium">Hi! I'm your RAG Assistant</p>
                        <p className="text-sm mt-1">Ask me about your knowledge base</p>
                        <p className="text-xs mt-2 text-gray-400">Try: "What documents do we have?" or select an item and click "Ask AI"</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {messages.map((message) => (
                        <motion.div
                          key={message.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`flex gap-2 ${
                            message.sender === 'user' ? 'justify-end' : 'justify-start'
                          }`}
                        >
                          {message.sender === 'agent' && (
                            <div className="flex-shrink-0">
                              <div className="w-7 h-7 rounded-full bg-purple-500 flex items-center justify-center">
                                <Bot className="w-4 h-4 text-white" />
                              </div>
                            </div>
                          )}
                          
                          <div
                            className={`max-w-[75%] rounded-lg px-3 py-2 ${
                              message.sender === 'user'
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                            }`}
                          >
                            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                            <p className={`text-xs mt-1 ${
                              message.sender === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
                            }`}>
                              {new Date(message.timestamp).toLocaleTimeString()}
                            </p>
                          </div>

                          {message.sender === 'user' && (
                            <div className="flex-shrink-0">
                              <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center">
                                <User className="w-4 h-4 text-white" />
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
                          className="flex gap-2 justify-start"
                        >
                          <div className="flex-shrink-0">
                            <div className="w-7 h-7 rounded-full bg-purple-500 flex items-center justify-center">
                              <Bot className="w-4 h-4 text-white" />
                            </div>
                          </div>
                          <div className="max-w-[75%] rounded-lg px-3 py-2 bg-gray-100 dark:bg-gray-800">
                            <p className="text-sm whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">
                              {streamingContent}
                            </p>
                          </div>
                        </motion.div>
                      )}

                      {/* Typing indicator */}
                      {isTyping && !streamingContent && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex gap-2 justify-start"
                        >
                          <div className="flex-shrink-0">
                            <div className="w-7 h-7 rounded-full bg-purple-500 flex items-center justify-center">
                              <Bot className="w-4 h-4 text-white" />
                            </div>
                          </div>
                          <div className="rounded-lg px-3 py-2 bg-gray-100 dark:bg-gray-800">
                            <div className="flex gap-1">
                              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                              <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                          </div>
                        </motion.div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>

                {/* Input Area */}
                <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex gap-2">
                    <input
                      ref={inputRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyPress={handleKeyPress}
                      placeholder="Ask about your knowledge base..."
                      disabled={loading || !sessionId}
                      className="flex-1 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 dark:text-white placeholder-gray-400"
                    />
                    <Button
                      onClick={() => sendMessage()}
                      variant="primary"
                      accentColor="purple"
                      disabled={loading || !input.trim() || !sessionId}
                      size="sm"
                    >
                      {loading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </motion.div>
      </AnimatePresence>
    );
  }
);

IntegratedRAGChat.displayName = 'IntegratedRAGChat';