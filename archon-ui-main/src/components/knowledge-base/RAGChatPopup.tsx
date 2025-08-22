import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Send, Bot, User, Sparkles, Loader2, X, Maximize2, Minimize2, MessageSquare, ChevronDown, Mic, MicOff, Copy, Check, RotateCcw } from 'lucide-react';
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

interface RAGChatPopupProps {
  className?: string;
}

export interface RAGChatPopupRef {
  askAboutItem: (item: any) => void;
  sendMessage: (message: string, context?: any) => void;
  open: () => void;
  close: () => void;
}



const scrollbarStyles = `
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(156, 163, 175, 0.5);
    border-radius: 3px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: rgba(156, 163, 175, 0.7);
  }
  .dark .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(75, 85, 99, 0.5);
  }
  .dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: rgba(75, 85, 99, 0.7);
  }
`;

const RAGChatPopup = forwardRef<RAGChatPopupRef, RAGChatPopupProps>(({ className = '' }, ref) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isTyping, setIsTyping] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [isMinimized, setIsMinimized] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [isListening, setIsListening] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const chatRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
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
              // Increment unread count if chat is closed or minimized
              if (!isOpen || isMinimized) {
                setUnreadCount(prev => prev + 1);
                // Play notification sound if available
                try {
                  const audio = new Audio('/notification.mp3');
                  audio.volume = 0.3;
                  audio.play().catch(() => {});
                } catch (e) {}
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

    // Clear unread count when opened and not minimized
    useEffect(() => {
      if (isOpen && !isMinimized) {
        setUnreadCount(0);
      }
    }, [isOpen, isMinimized]);

    // Auto-scroll to bottom only when new messages arrive (not during streaming)
    useEffect(() => {
      if (!isMinimized && messages.length > 0) {
        // Small delay to ensure DOM is updated
        setTimeout(() => {
          if (messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
          }
        }, 100);
      }
    }, [messages.length, isMinimized]);

    // Keyboard shortcuts
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Escape to close/minimize
        if (e.key === 'Escape' && isOpen) {
          if (isMinimized) {
            setIsOpen(false);
          } else {
            setIsMinimized(true);
          }
        }
        
        // Cmd/Ctrl + K to open/focus chat
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
            setIsMinimized(false);
            setTimeout(() => inputRef.current?.focus(), 100);
          } else {
            inputRef.current?.focus();
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, isMinimized]);

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
      
      // Open popup if closed
      if (!isOpen) {
        setIsOpen(true);
        setIsMinimized(false);
      } else if (isMinimized) {
        setIsMinimized(false);
      }
      
      // Focus input after asking
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    const open = () => {
      setIsOpen(true);
      setIsMinimized(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    const close = () => {
      setIsOpen(false);
      setIsMinimized(false);
    };

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      askAboutItem,
      sendMessage,
      open,
      close,
    }));

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    const copyMessage = (content: string, messageId: string) => {
      navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
      showToast('Message copied to clipboard', 'success');
    };

    const clearChat = () => {
      setMessages([]);
      showToast('Chat history cleared', 'info');
    };



    // Responsive sizes
    const isMobile = window.innerWidth < 640;
    const chatWidth = isMobile ? window.innerWidth - 32 : 420;
    const chatHeight = isMobile ? window.innerHeight - 100 : 600;

    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: scrollbarStyles }} />
        {/* Floating Action Button */}
        <AnimatePresence>
          {!isOpen && (
            <motion.button
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              onClick={open}
              className="fixed bottom-6 right-6 z-40 w-14 h-14 bg-gradient-to-br from-purple-500 to-blue-600 text-white rounded-full shadow-lg hover:shadow-xl flex items-center justify-center group"
            >
              <MessageSquare className="w-6 h-6" />
              {unreadCount > 0 && (
                <motion.div 
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute -top-1 -right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs font-bold animate-pulse"
                >
                  {unreadCount > 9 ? '9+' : unreadCount}
                </motion.div>
              )}
              <div className="absolute bottom-full mb-2 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                RAG Assistant
                <span className="block text-gray-400 text-xs mt-0.5">⌘K to open</span>
              </div>
            </motion.button>
          )}
        </AnimatePresence>

        {/* Chat Popup */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              ref={chatRef}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ 
                opacity: 1, 
                scale: 1
              }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className={`fixed z-50 ${className}`}
              style={{ 
                ...(isMobile ? { 
                  bottom: '16px',
                  left: '16px',
                  right: '16px',
                  width: 'calc(100% - 32px)',
                  height: isMinimized ? '56px' : 'calc(100vh - 100px)'
                } : { 
                  bottom: '24px',
                  right: '24px',
                  width: '420px',
                  height: isMinimized ? '56px' : '600px'
                })
              }}
            >
              <div className="h-full bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700 rounded-lg flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-purple-500/10 to-blue-500/10">
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Sparkles className="w-5 h-5 text-purple-500" />
                      <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    </div>
                    <h3 className="font-semibold text-gray-800 dark:text-white">RAG Assistant</h3>
                    {loading && (
                      <Badge color="purple" variant="outline" size="sm">
                        <Loader2 className="w-3 h-3 animate-spin mr-1" />
                        Thinking...
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      onClick={clearChat}
                      variant="ghost"
                      size="sm"
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                      title="Clear chat"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                    <Button
                      onClick={() => setIsMinimized(!isMinimized)}
                      variant="ghost"
                      size="sm"
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                      title={isMinimized ? "Expand" : "Minimize"}
                    >
                      {isMinimized ? <Maximize2 className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </Button>
                    <Button
                      onClick={close}
                      variant="ghost"
                      size="sm"
                      className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
                      title="Close (Esc)"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Chat Content - Only visible when not minimized */}
                {!isMinimized && (
                  <>
                    {/* Messages Area with proper scrolling */}
                    <div 
                      ref={messagesContainerRef}
                      className="flex-grow overflow-y-scroll custom-scrollbar p-4"
                      style={{ height: 0 }}
                    >
                      {messages.length === 0 && !streamingContent ? (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400"
                        >
                          <div className="text-center">
                            <Bot className="w-16 h-16 mx-auto mb-4 text-purple-400 opacity-50" />
                            <p className="font-medium text-lg mb-2">Hi! I'm your RAG Assistant 👋</p>
                            <p className="text-sm mb-4">I can help you explore your knowledge base</p>
                            <div className="space-y-2 text-xs text-gray-400">
                              <p>💡 Try asking:</p>
                              <p className="italic">"What documents do we have?"</p>
                              <p className="italic">"Summarize the latest updates"</p>
                              <p className="italic">"Find information about [topic]"</p>
                            </div>
                          </div>
                        </motion.div>
                      ) : (
                        <div className="space-y-3">
                            {messages.map((message, index) => (
                              <motion.div
                                key={message.id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: index * 0.05 }}
                                className={`flex gap-2 ${
                                  message.sender === 'user' ? 'justify-end' : 'justify-start'
                                }`}
                              >
                                {message.sender === 'agent' && (
                                  <div className="flex-shrink-0 mt-1">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                                      <Bot className="w-5 h-5 text-white" />
                                    </div>
                                  </div>
                                )}
                                
                                <div className={`group relative max-w-[80%]`}>
                                  <div
                                    className={`rounded-2xl px-4 py-3 ${
                                      message.sender === 'user'
                                        ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white'
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
                                            code: ({inline, children}) => 
                                              inline ? (
                                                <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">{children}</code>
                                              ) : (
                                                <code className="block p-2 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono overflow-x-auto">{children}</code>
                                              ),
                                            pre: ({children}) => 
                                                <pre className="p-2 bg-gray-200 dark:bg-gray-700 rounded overflow-x-auto mb-2">{children}</pre>,
                                            a: ({href, children}) => 
                                              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">{children}</a>,
                                            h1: ({children}) => <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>,
                                            h2: ({children}) => <h2 className="text-base font-bold mb-2 mt-3">{children}</h2>,
                                            h3: ({children}) => <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>,
                                            blockquote: ({children}) => <blockquote className="border-l-4 border-purple-400 pl-3 italic my-2">{children}</blockquote>,
                                          }}
                                        >
                                          {message.content}
                                        </ReactMarkdown>
                                      </div>
                                    ) : (
                                      <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                                    )}
                                  </div>
                                  
                                  {/* Message actions */}
                                  <div className={`absolute top-0 ${message.sender === 'user' ? 'right-full mr-2' : 'left-full ml-2'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                                    <Button
                                      onClick={() => copyMessage(message.content, message.id)}
                                      variant="ghost"
                                      size="sm"
                                      className="p-1"
                                    >
                                      {copiedMessageId === message.id ? (
                                        <Check className="w-3 h-3 text-green-500" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </Button>
                                  </div>
                                  
                                  <p className={`text-xs mt-1 ${
                                    message.sender === 'user' ? 'text-right text-blue-200' : 'text-gray-500 dark:text-gray-400'
                                  }`}>
                                    {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </p>
                                </div>

                                {message.sender === 'user' && (
                                  <div className="flex-shrink-0 mt-1">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-400 to-gray-600 flex items-center justify-center">
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
                                className="flex gap-2 justify-start"
                              >
                                <div className="flex-shrink-0 mt-1">
                                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                                    <Bot className="w-5 h-5 text-white" />
                                  </div>
                                </div>
                                <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-gray-100 dark:bg-gray-800">
                                  <div className="prose prose-sm dark:prose-invert max-w-none">
                                    <ReactMarkdown 
                                      remarkPlugins={[remarkGfm]}
                                      components={{
                                        p: ({children}) => <p className="mb-2 text-sm leading-relaxed">{children}</p>,
                                        ul: ({children}) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                                        ol: ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                                        li: ({children}) => <li className="text-sm">{children}</li>,
                                        strong: ({children}) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                                        code: ({inline, children}) => 
                                          inline ? (
                                            <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono">{children}</code>
                                          ) : (
                                            <code className="block p-2 bg-gray-200 dark:bg-gray-700 rounded text-xs font-mono overflow-x-auto">{children}</code>
                                          ),
                                        pre: ({children}) => 
                                            <pre className="p-2 bg-gray-200 dark:bg-gray-700 rounded overflow-x-auto mb-2">{children}</pre>,
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
                                <div className="flex-shrink-0 mt-1">
                                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                                    <Bot className="w-5 h-5 text-white" />
                                  </div>
                                </div>
                                <div className="rounded-2xl px-4 py-3 bg-gray-100 dark:bg-gray-800">
                                  <div className="flex gap-1">
                                    <motion.div 
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ repeat: Infinity, duration: 1, delay: 0 }}
                                      className="w-2 h-2 bg-gray-500 rounded-full" 
                                    />
                                    <motion.div 
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ repeat: Infinity, duration: 1, delay: 0.2 }}
                                      className="w-2 h-2 bg-gray-500 rounded-full" 
                                    />
                                    <motion.div 
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ repeat: Infinity, duration: 1, delay: 0.4 }}
                                      className="w-2 h-2 bg-gray-500 rounded-full" 
                                    />
                                  </div>
                                </div>
                              </motion.div>
                            )}
                            <div ref={messagesEndRef} />
                          </div>
                        )}
                    </div>

                    {/* Input Area - Fixed at bottom */}
                    <div className="flex-shrink-0 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                        <div className="flex gap-2">
                          <div className="flex-1 relative">
                            <textarea
                              ref={inputRef}
                              value={input}
                              onChange={(e) => setInput(e.target.value)}
                              onKeyDown={handleKeyPress}
                              placeholder="Ask about your knowledge base..."
                              disabled={loading || !sessionId}
                              rows={1}
                              className="w-full px-4 py-2.5 pr-10 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 dark:text-white placeholder-gray-400 resize-none transition-all"
                              style={{ minHeight: '42px', maxHeight: '120px' }}
                              onInput={(e) => {
                                const target = e.target as HTMLTextAreaElement;
                                target.style.height = 'auto';
                                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                              }}
                            />
                            {/* Voice input button (placeholder) */}
                            <button
                              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                              onClick={() => {
                                setIsListening(!isListening);
                                showToast('Voice input coming soon!', 'info');
                              }}
                            >
                              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                            </button>
                          </div>
                          <Button
                            onClick={() => sendMessage()}
                            variant="primary"
                            accentColor="purple"
                            disabled={loading || !input.trim() || !sessionId}
                            size="sm"
                            className="px-4 h-[42px]"
                          >
                            {loading ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Send className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                        <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
                          <span>Press Enter to send, Shift+Enter for new line</span>
                      <span>⌘K to focus</span>
                    </div>
                  </div>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }
);

RAGChatPopup.displayName = 'RAGChatPopup';

export { RAGChatPopup };