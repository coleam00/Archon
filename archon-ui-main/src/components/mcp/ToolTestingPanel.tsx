import React, { useEffect, useState, useRef } from 'react';
import { X, Play, ChevronDown, TerminalSquare, Copy, Check, MinusCircle, Maximize2, Minimize2, Hammer, GripHorizontal } from 'lucide-react';
import { Client, Tool } from './MCPClients';
import { Button } from '../ui/Button';
import { mcpClientService } from '../../services/mcpClientService';
import { ErrorAlert, useErrorHandler } from '../ui/ErrorAlert';
import { parseKnowledgeBaseError, EnhancedError } from '../../services/knowledgeBaseErrorHandler';

interface ToolTestingPanelProps {
  client: Client | null;
  isOpen: boolean;
  onClose: () => void;
}

interface TerminalLine {
  id: string;
  content: string;
  isTyping: boolean;
  isCommand: boolean;
  isError?: boolean;
  isWarning?: boolean;
}

export const ToolTestingPanel = ({
  client,
  isOpen,
  onClose
}: ToolTestingPanelProps) => {
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<TerminalLine[]>([{
    id: '1',
    content: '> Tool testing terminal ready',
    isTyping: false,
    isCommand: true
  }]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [isCopied, setIsCopied] = useState(false);
  const [panelHeight, setPanelHeight] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const { error, setError, clearError } = useErrorHandler();
  const terminalRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number>(400);

  // Reset selected tool when client changes
  useEffect(() => {
    if (client && client.tools.length > 0) {
      setSelectedTool(client.tools[0]);
      setParamValues({});
    } else {
      setSelectedTool(null);
      setParamValues({});
    }
  }, [client]);

  // Auto-scroll terminal to bottom when output changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  // Handle resizing functionality
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing && panelRef.current) {
        const containerHeight = window.innerHeight;
        const mouseY = e.clientY;
        const newHeight = containerHeight - mouseY;
        if (newHeight >= 200 && newHeight <= containerHeight * 0.8) {
          setPanelHeight(newHeight);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Cleanup error state on component unmount
  useEffect(() => {
    return () => {
      clearError(); // Clear any pending errors when component unmounts
    };
  }, [clearError]);

  // Handle tool selection
  const handleToolSelect = (tool: Tool) => {
    setSelectedTool(tool);
    setParamValues({});
  };

  // Handle parameter value change
  const handleParamChange = (paramName: string, value: string) => {
    setParamValues(prev => ({
      ...prev,
      [paramName]: value
    }));
  };

  // Simulate typing animation for terminal output
  const addTypingLine = (content: string, isCommand: boolean = false, isError: boolean = false, isWarning: boolean = false) => {
    const newLineId = Date.now().toString() + Math.random().toString(36).substring(2);
    
    setTerminalOutput(prev => [...prev, {
      id: newLineId,
      content: '',
      isTyping: true,
      isCommand,
      isError,
      isWarning
    }]);

    // Simulate typing animation
    let currentText = '';
    const textArray = content.split('');
    const typeInterval = setInterval(() => {
      if (textArray.length > 0) {
        currentText += textArray.shift();
        setTerminalOutput(prev => prev.map(line => 
          line.id === newLineId ? {
            ...line,
            content: currentText
          } : line
        ));
      } else {
        clearInterval(typeInterval);
        setTerminalOutput(prev => prev.map(line => 
          line.id === newLineId ? {
            ...line,
            isTyping: false
          } : line
        ));
      }
    }, 15); // Faster typing

    return newLineId;
  };

  // Add instant line (no typing effect)
  const addInstantLine = (content: string, isCommand: boolean = false, isError: boolean = false, isWarning: boolean = false) => {
    const newLineId = Date.now().toString() + Math.random().toString(36).substring(2);
    
    setTerminalOutput(prev => [...prev, {
      id: newLineId,
      content,
      isTyping: false,
      isCommand,
      isError,
      isWarning
    }]);

    return newLineId;
  };

  // Convert parameter values to proper types
  const convertParameterValues = (): Record<string, any> => {
    if (!selectedTool) return {};

    const convertedParams: Record<string, any> = {};
    
    selectedTool.parameters.forEach(param => {
      const value = paramValues[param.name];
      
      if (value !== undefined && value !== '') {
        try {
          switch (param.type) {
            case 'number':
              convertedParams[param.name] = Number(value);
              if (isNaN(convertedParams[param.name])) {
                throw new Error(`Invalid number: ${value}`);
              }
              break;
            case 'boolean':
              convertedParams[param.name] = value.toLowerCase() === 'true' || value === '1';
              break;
            case 'array':
              // Try to parse as JSON array first, fallback to comma-separated
              try {
                convertedParams[param.name] = JSON.parse(value);
                if (!Array.isArray(convertedParams[param.name])) {
                  throw new Error('Not an array');
                }
              } catch {
                convertedParams[param.name] = value.split(',').map(v => v.trim()).filter(v => v);
              }
              break;
            default:
              convertedParams[param.name] = value;
          }
        } catch (error) {
          console.warn(`Parameter conversion error for ${param.name}:`, error);
          convertedParams[param.name] = value; // Fallback to string
        }
      }
    });

    return convertedParams;
  };



  // Execute tool using universal MCP client service (works for ALL clients)
  const executeTool = async () => {
    if (!selectedTool || !client) return;

    try {
      const convertedParams = convertParameterValues();
      
      addTypingLine(`> Connecting to ${client.name} via MCP protocol...`);
      
      // Call the client tool via MCP service
      const result = await mcpClientService.callClientTool({
        client_id: client.id,
        tool_name: selectedTool.name,
        arguments: convertedParams
      });
      
      setTimeout(() => addTypingLine('> Tool executed successfully'), 300);
      
      // Display the result
      setTimeout(() => {
        if (result) {
          let resultText = '';
          
          if (typeof result === 'object') {
            if (result.content) {
              // Handle MCP content response
              if (Array.isArray(result.content)) {
                resultText = result.content.map((item: any) => 
                  item.text || JSON.stringify(item, null, 2)
                ).join('\n');
              } else {
                resultText = result.content.text || JSON.stringify(result.content, null, 2);
              }
            } else {
              resultText = JSON.stringify(result, null, 2);
            }
          } else {
            resultText = String(result);
          }
          
          addInstantLine('> Result:');
          addInstantLine(resultText);
        } else {
          addTypingLine('> No result returned');
        }
        
        addTypingLine('> Completed successfully');
        setIsExecuting(false);
      }, 600);

    } catch (error: any) {
      console.error('MCP tool execution failed:', error);
      
      // Parse error through enhanced error handler for better user experience
      const enhancedError = parseKnowledgeBaseError(error);
      setError(enhancedError);
      
      setTimeout(() => {
        addTypingLine(`> ERROR: Failed to execute tool on ${client.name}`, false, true);
        addTypingLine(`> ${error.message || 'Unknown error occurred'}`, false, true);
        
        // Add special handling for OpenAI/RAG related errors
        if (enhancedError.isOpenAIError && enhancedError.errorDetails) {
          addTypingLine(`> Error Type: ${enhancedError.errorDetails.error_type}`, false, true);
          if (enhancedError.errorDetails.tokens_used) {
            addTypingLine(`> Tokens Used: ${enhancedError.errorDetails.tokens_used}`, false, true);
          }
        }
        
        addTypingLine('> Execution failed');
        setIsExecuting(false);
      }, 300);
    }
  };

  // Validate required parameters
  const validateParameters = (): string | null => {
    if (!selectedTool) return 'No tool selected';

    for (const param of selectedTool.parameters) {
      if (param.required && !paramValues[param.name]) {
        return `Required parameter '${param.name}' is missing`;
      }
    }

    return null;
  };

  // Handle tool execution
  const executeSelectedTool = () => {
    if (!selectedTool || !client || isExecuting) return;

    // Clear any previous errors
    clearError();

    // Validate required parameters
    const validationError = validateParameters();
    if (validationError) {
      addTypingLine(`> ERROR: ${validationError}`, false, true);
      return;
    }

    setIsExecuting(true);

    // Add command to terminal
    const params = selectedTool.parameters.map(p => {
      const value = paramValues[p.name];
      return value ? `${p.name}=${value}` : undefined;
    }).filter(Boolean).join(' ');

    const command = `> execute ${selectedTool.name} ${params}`;
    addTypingLine(command, true);

    // Execute using universal client service for ALL clients
    setTimeout(() => {
      executeTool();
    }, 200);
  };

  // Handle copy terminal output
  const copyTerminalOutput = () => {
    const textContent = terminalOutput.map(line => line.content).join('\n');
    navigator.clipboard.writeText(textContent);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Handle resize start
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  // Handle maximize/minimize
  const toggleMaximize = () => {
    if (isMaximized) {
      setPanelHeight(previousHeightRef.current);
    } else {
      previousHeightRef.current = panelHeight;
      setPanelHeight(window.innerHeight * 0.8);
    }
    setIsMaximized(!isMaximized);
  };

  // Clear terminal
  const clearTerminal = () => {
    setTerminalOutput([{
      id: Date.now().toString(),
      content: '> Terminal cleared',
      isTyping: false,
      isCommand: true
    }]);
  };

  if (!isOpen || !client) return null;

  return (
    <div 
      ref={panelRef} 
      className={`fixed bottom-0 left-1/2 transform -translate-x-1/2 backdrop-blur-md bg-gradient-to-t from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border-t border-gray-200 dark:border-gray-800 transition-all duration-500 ease-in-out z-30 shadow-2xl rounded-t-xl overflow-hidden ${isOpen ? 'translate-y-0' : 'translate-y-full'}`} 
      style={{
        height: `${panelHeight}px`,
        width: 'calc(100% - 4rem)',
        maxWidth: '1400px'
      }}
    >
      {/* Resize handle at the top */}
      <div 
        ref={resizeHandleRef} 
        className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize group transform -translate-y-1 z-10" 
        onMouseDown={handleResizeStart}
      >
        <div className="w-16 h-1 mx-auto bg-gray-300 dark:bg-gray-600 rounded-full group-hover:bg-cyan-400 dark:group-hover:bg-cyan-500 transition-colors"></div>
      </div>

      {/* Panel with neon effect */}
      <div className="relative h-full">
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-cyan-500 shadow-[0_0_20px_5px_rgba(34,211,238,0.7),0_0_10px_2px_rgba(34,211,238,1.0)] dark:shadow-[0_0_25px_8px_rgba(34,211,238,0.8),0_0_15px_3px_rgba(34,211,238,1.0)]"></div>
        
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white flex items-center">
            <span className={`w-2 h-2 rounded-full mr-2 ${
              client.status === 'online' 
                ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]' 
                : client.status === 'offline' 
                ? 'bg-gray-400' 
                : 'bg-pink-400 shadow-[0_0_8px_rgba(236,72,153,0.6)]'
            }`}></span>
            {client.name}
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
              {client.ip}
            </span>
            <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
              {client.tools.length} tools available
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <button 
              onClick={clearTerminal}
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
              title="Clear terminal"
            >
              <TerminalSquare className="w-4 h-4" />
            </button>
            <button 
              onClick={toggleMaximize} 
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors" 
              title={isMaximized ? 'Minimize panel' : 'Maximize panel'}
            >
              {isMaximized ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
            <button 
              onClick={onClose} 
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors" 
              title="Close panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4 h-[calc(100%-73px)] overflow-y-auto">
          {/* Error Alert for OpenAI/RAG errors */}
          <ErrorAlert error={error} onDismiss={clearError} />
          
          {client.tools.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Hammer className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No Tools Available</h3>
                <p className="text-gray-500 dark:text-gray-400">
                  {client.status === 'offline' 
                    ? 'Client is offline. Tools will be available when connected.'
                    : 'No tools discovered for this client.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left column: Tool selection and parameters */}
              <div>
                {/* Tool selection and execute button row */}
                <div className="flex gap-4 mb-6">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      Select Tool
                    </label>
                    <div className="relative">
                      <select 
                        className="w-full bg-white/50 dark:bg-black/50 border border-gray-300 dark:border-gray-700 rounded-md py-2 pl-3 pr-10 text-gray-900 dark:text-white appearance-none focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500" 
                        value={selectedTool?.id || ''} 
                        onChange={e => {
                          const tool = client.tools.find(t => t.id === e.target.value);
                          if (tool) handleToolSelect(tool);
                        }}
                      >
                        {client.tools.map(tool => (
                          <option key={tool.id} value={tool.id}>
                            {tool.name}
                          </option>
                        ))}
                      </select>
                      <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-end">
                    <Button 
                      variant="primary" 
                      accentColor="cyan" 
                      onClick={executeSelectedTool} 
                      disabled={!selectedTool || isExecuting}
                    >
                      {isExecuting ? (
                        <div className="flex items-center">
                          <span className="inline-block w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                          Executing...
                        </div>
                      ) : (
                        <>
                          <Play className="w-4 h-4 mr-2" />
                          Execute Tool
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Tool description */}
                {selectedTool && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    {selectedTool.description}
                  </p>
                )}

                {/* Parameters */}
                {selectedTool && selectedTool.parameters.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                      Parameters
                    </h4>
                    <div className="space-y-3">
                      {selectedTool.parameters.map(param => (
                        <div key={param.name}>
                          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                            {param.name}
                            {param.required && <span className="text-pink-500 ml-1">*</span>}
                            <span className="text-gray-400 ml-1">({param.type})</span>
                          </label>
                          <input 
                            type={param.type === 'number' ? 'number' : 'text'} 
                            value={paramValues[param.name] || ''} 
                            onChange={e => handleParamChange(param.name, e.target.value)} 
                            className="w-full px-3 py-2 text-sm bg-white/50 dark:bg-black/50 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 transition-all duration-200" 
                            placeholder={param.description || `Enter ${param.name}`}
                          />
                          {param.description && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              {param.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right column: Terminal output */}
              <div className="flex flex-col h-full">
                <div className="flex-1 bg-gray-900 rounded-lg overflow-hidden relative border border-gray-800 h-full">
                  <div className="flex items-center justify-between bg-gray-800 px-3 py-2">
                    <div className="flex items-center">
                      <TerminalSquare className="w-4 h-4 text-cyan-400 mr-2" />
                      <span className="text-xs text-gray-300 font-medium">
                        Terminal Output
                      </span>
                    </div>
                    <button 
                      onClick={copyTerminalOutput} 
                      className="p-1 rounded hover:bg-gray-700 transition-colors" 
                      title="Copy output"
                    >
                      {isCopied ? 
                        <Check className="w-4 h-4 text-green-400" /> : 
                        <Copy className="w-4 h-4 text-gray-400 hover:text-gray-300" />
                      }
                    </button>
                  </div>
                  <div 
                    ref={terminalRef} 
                    className="p-3 h-[calc(100%-36px)] overflow-y-auto font-mono text-xs text-gray-300 space-y-1"
                  >
                    {terminalOutput.map(line => (
                      <div key={line.id} className={`
                          ${line.isCommand ? 'text-cyan-400' : ''}
                          ${line.isWarning ? 'text-yellow-400' : ''}
                          ${line.isError ? 'text-pink-400' : ''}
                          ${line.isTyping ? 'terminal-typing' : ''}
                          whitespace-pre-wrap
                        `}>
                        {line.content}
                        {line.isTyping && <span className="terminal-cursor">▌</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};