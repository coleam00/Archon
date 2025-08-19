import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Send, Bot, User, Sparkles, Loader2, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  onUnreadCountChange?: (count: number) => void;
  className?: string;
}

export interface IntegratedRAGChatRef {
  askAboutItem: (item: any) => void;
  sendMessage: (message: string, context?: any) => void;
}

const IntegratedRAGChat = forwardRef<IntegratedRAGChatRef, IntegratedRAGChatProps>(({ isExpanded, onToggleExpand, onUnreadCountChange, className = '' }, ref) => {
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
                setUnreadCount(prev => {
                  const newCount = prev + 1;
                  onUnreadCountChange?.(newCount);
                  return newCount;
                });
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
        onUnreadCountChange?.(0);
      }
    }, [isExpanded, onUnreadCountChange]);

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
          initial={{ height: isExpanded ? 0 : 80 }}
          animate={{ 
            height: isExpanded ? (isFullscreen ? '100vh' : '66vh') : 80,
            width: '100%'
          }}
          exit={{ height: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className={`${isFullscreen ? 'fixed inset-0 z-50' : 'relative'} ${className}`}
        >
          <Card className={`h-full flex flex-col bg-gradient-to-br from-purple-500/5 via-blue-500/5 to-purple-500/5 border-purple-500/20 ${isFullscreen ? '' : 'rounded-lg'}`}>
            {/* Header - Only show when expanded */}
            {isExpanded && (
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-500" />
                  <h3 className="font-semibold text-gray-800 dark:text-white">RAG Assistant</h3>
                  <Badge color="green" variant="outline">Online</Badge>
                  {unreadCount > 0 && (
                    <Badge color="orange" variant="solid">{unreadCount}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                      onClick={toggleFullscreen}
                      variant="ghost"
                      size="sm"
                      accentColor="blue"
                    >
                      {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </Button>
                    <Button
                      onClick={onToggleExpand}
                      variant="ghost"
                      size="sm"
                      accentColor="blue"
                    >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Chat Content - Only visible when expanded */}
            {isExpanded && (
              <>
                {/* Messages Area */}
                <div className={`flex-1 overflow-y-auto p-4 ${isFullscreen ? 'max-h-[calc(100vh-180px)]' : 'h-[calc(66vh-180px)]'}`}>
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
                            className={`max-w-[85%] rounded-lg px-4 py-3 ${
                              message.sender === 'user'
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                            }`}
                          >
                            {message.sender === 'agent' ? (
                              <div className="prose prose-sm dark:prose-invert max-w-none">
                                <ReactMarkdown 
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({children}) => <p className="mb-2 text-sm leading-relaxed">{children}</p>,
                                    ul: ({children}) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                                    ol: ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                                    li: ({children}) => <li className="text-sm">{children}</li>,
                                    strong: ({children}) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                                    code: ({children}) => 
                                        <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">{children}</code>,
                                    pre: ({children}) => 
                                        <pre className="p-2 bg-gray-200 dark:bg-gray-700 rounded overflow-x-auto">{children}</pre>,
                                    a: ({href, children}) => 
                                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{children}</a>,
                                    h1: ({children}) => <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>,
                                    h2: ({children}) => <h2 className="text-base font-bold mb-2 mt-3">{children}</h2>,
                                    h3: ({children}) => <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>,
                                    blockquote: ({children}) => <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-3 italic my-2">{children}</blockquote>,
                                  }}
                                >
                                  {message.content}
                                </ReactMarkdown>
                              </div>
                            ) : (
                              <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                            )}
                            <p className={`text-xs mt-2 ${
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
                          <div className="max-w-[85%] rounded-lg px-4 py-3 bg-gray-100 dark:bg-gray-800">
                            <div className="prose prose-sm dark:prose-invert max-w-none">
                              <ReactMarkdown 
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  p: ({children}) => <p className="mb-2 text-sm leading-relaxed">{children}</p>,
                                  ul: ({children}) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                                  ol: ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                                  li: ({children}) => <li className="text-sm">{children}</li>,
                                  strong: ({children}) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                                  code: ({children}) => 
                                      <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">{children}</code>,
                                  pre: ({children}) => 
                                      <pre className="p-2 bg-gray-200 dark:bg-gray-700 rounded overflow-x-auto">{children}</pre>,
                                  a: ({href, children}) => 
                                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{children}</a>,
                                }}
                              >
                                {streamingContent}
                              </ReactMarkdown>
                            </div>
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
                      onKeyDown={handleKeyPress}
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

export { IntegratedRAGChat };
