import { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, Play, Square, Clock, CheckCircle, XCircle, FileText, ChevronUp, ChevronDown, BarChart } from 'lucide-react';
// Card component not used but preserved for future use
// import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { TestResultsModal } from '../ui/TestResultsModal';
import { TestResultDashboard } from '../ui/TestResultDashboard';
import { testService, TestExecution, TestStreamMessage, TestType } from '../../services/testService';
import { useToast } from '../../contexts/ToastContext';
import { motion, AnimatePresence } from 'framer-motion';
import { useTerminalScroll } from '../../hooks/useTerminalScroll';

interface TestResult {
  name: string;
  status: 'running' | 'passed' | 'failed' | 'skipped';
  duration?: number;
  error?: string;
}

interface TestExecutionState {
  execution?: TestExecution;
  logs: string[];
  isRunning: boolean;
  duration?: number;
  exitCode?: number;
  // Pretty mode data
  results: TestResult[];
  summary?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

export const TestStatus = () => {
  const [displayMode, setDisplayMode] = useState<'pretty' | 'dashboard'>('pretty');
  const [mcpErrorsExpanded, setMcpErrorsExpanded] = useState(false);
  const [uiErrorsExpanded, setUiErrorsExpanded] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true); // Start collapsed by default
  const [showTestResultsModal, setShowTestResultsModal] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [hasResults, setHasResults] = useState(false);
  
  const [mcpTest, setMcpTest] = useState<TestExecutionState>({
    logs: ['> Ready to run Python tests...'],
    isRunning: false,
    results: []
  });
  
  const [uiTest, setUiTest] = useState<TestExecutionState>({
    logs: ['> Ready to run React UI tests...'],
    isRunning: false,
    results: []
  });

  // Use terminal scroll hooks
  const mcpTerminalRef = useTerminalScroll([mcpTest.logs], !isCollapsed);
  const uiTerminalRef = useTerminalScroll([uiTest.logs], !isCollapsed);

  // WebSocket cleanup functions
  const wsCleanupRefs = useRef<Map<string, () => void>>(new Map());
  const { showToast } = useToast();

  // Cleanup WebSocket connections on unmount
  useEffect(() => {
    return () => {
      wsCleanupRefs.current.forEach((cleanup) => cleanup());
      testService.disconnectAllStreams();
    };
  }, []);

  // Test results availability - not implemented yet
  useEffect(() => {
    setHasResults(false);
  }, []);

  // Check for results when UI tests complete
  useEffect(() => {
    if (!uiTest.isRunning && uiTest.exitCode === 0) {
      setHasResults(false);
    }
  }, [uiTest.isRunning, uiTest.exitCode]);

  const updateTestState = (
    testType: TestType,
    updater: (prev: TestExecutionState) => TestExecutionState
  ) => {
    switch (testType) {
      case 'mcp':
        setMcpTest(updater);
        break;
      case 'ui':
        setUiTest(updater);
        break;
    }
  };

  const parseTestOutput = (log: string): TestResult | null => {
    // Parse Python test output (pytest format)
    if (log.includes('::') && (log.includes('PASSED') || log.includes('FAILED') || log.includes('SKIPPED'))) {
      const parts = log.split('::');
      if (parts.length >= 2) {
        const name = parts[parts.length - 1].split(' ')[0];
        const status = log.includes('PASSED') ? 'passed' : 
                     log.includes('FAILED') ? 'failed' : 'skipped';
        
        // Extract duration if present
        const durationMatch = log.match(/\[([\d.]+)s\]/);
        const duration = durationMatch ? parseFloat(durationMatch[1]) : undefined;
        
        return { name, status, duration };
      }
    }

    // Parse React test output (vitest format)
    if (log.includes('✓') || log.includes('✕') || log.includes('○')) {
      const testNameMatch = log.match(/[✓✕○]\s+(.+?)(?:\s+\([\d.]+s\))?$/);
      if (testNameMatch) {
        const name = testNameMatch[1];
        const status = log.includes('✓') ? 'passed' : 
                     log.includes('✕') ? 'failed' : 'skipped';
        
        const durationMatch = log.match(/\(([\d.]+)s\)/);
        const duration = durationMatch ? parseFloat(durationMatch[1]) : undefined;
        
        return { name, status, duration };
      }
    }

    return null;
  };

  const updateSummaryFromLogs = (logs: string[]) => {
    // Extract summary from test output
    const summaryLine = logs.find(log => 
      log.includes('passed') && log.includes('failed') || 
      log.includes('Test Files') || 
      log.includes('Tests ')
    );

    if (summaryLine) {
      // Python format: "10 failed | 37 passed (47)"
      const pythonMatch = summaryLine.match(/(\d+)\s+failed\s+\|\s+(\d+)\s+passed\s+\((\d+)\)/);
      if (pythonMatch) {
        return {
          failed: parseInt(pythonMatch[1]),
          passed: parseInt(pythonMatch[2]),
          total: parseInt(pythonMatch[3]),
          skipped: 0
        };
      }

      // React format: "Test Files  3 failed | 4 passed (7)"
      const reactMatch = summaryLine.match(/Test Files\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed\s+\((\d+)\)/);
      if (reactMatch) {
        return {
          failed: parseInt(reactMatch[1]),
          passed: parseInt(reactMatch[2]),
          total: parseInt(reactMatch[3]),
          skipped: 0
        };
      }
    }

    return undefined;
  };

  const handleStreamMessage = (testType: TestType, message: TestStreamMessage) => {
    updateTestState(testType, (prev) => {
      const newLogs = [...prev.logs];
      const newResults = [...prev.results];

      switch (message.type) {
        case 'status':
          if (message.data?.status) {
            newLogs.push(`> Status: ${message.data.status}`);
          }
          break;
        case 'output':
          if (message.message) {
            newLogs.push(message.message);
            
            // Parse test results for pretty mode
            const testResult = parseTestOutput(message.message);
            if (testResult) {
              // Update existing result or add new one
              const existingIndex = newResults.findIndex(r => r.name === testResult.name);
              if (existingIndex >= 0) {
                newResults[existingIndex] = testResult;
              } else {
                newResults.push(testResult);
              }
            }
          }
          break;
        case 'completed':
          newLogs.push('> Test execution completed.');
          const summary = updateSummaryFromLogs(newLogs);
          return {
            ...prev,
            logs: newLogs,
            results: newResults,
            summary,
            isRunning: false,
            duration: message.data?.duration,
            exitCode: message.data?.exit_code
          };
        case 'error':
          newLogs.push(`> Error: ${message.message || 'Unknown error'}`);
          return {
            ...prev,
            logs: newLogs,
            results: newResults,
            isRunning: false,
            exitCode: 1
          };
        case 'cancelled':
          newLogs.push('> Test execution cancelled.');
          return {
            ...prev,
            logs: newLogs,
            results: newResults,
            isRunning: false,
            exitCode: -1
          };
      }

      return {
        ...prev,
        logs: newLogs,
        results: newResults
      };
    });
  };

  const runTest = async (testType: TestType) => {
    console.log(`[DEBUG] runTest called with testType: ${testType}`);
    try {
      // Reset test state
      console.log(`[DEBUG] Resetting test state for ${testType}`);
      updateTestState(testType, (prev) => ({
        ...prev,
        logs: [`> Starting ${testType === 'mcp' ? 'Python' : 'React UI'} tests...`],
        results: [],
        summary: undefined,
        isRunning: true,
        duration: undefined,
        exitCode: undefined
      }));

      if (testType === 'mcp') {
        console.log('[DEBUG] Running MCP tests via backend API');
        // Python tests: Use backend API with WebSocket streaming
        const execution = await testService.runMCPTests();
        console.log('[DEBUG] MCP test execution response:', execution);
        
        // Update state with execution info
        updateTestState(testType, (prev) => ({
          ...prev,
          execution,
          logs: [...prev.logs, `> Execution ID: ${execution.execution_id}`, '> Connecting to real-time stream...']
        }));

        // Connect to WebSocket stream for real-time updates
        const cleanup = testService.connectToTestStream(
          execution.execution_id,
          (message) => handleStreamMessage(testType, message),
          (error) => {
            console.error('WebSocket error:', error);
            updateTestState(testType, (prev) => ({
              ...prev,
              logs: [...prev.logs, '> WebSocket connection error'],
              isRunning: false
            }));
            showToast('WebSocket connection error', 'error');
          },
          (event) => {
            console.log('WebSocket closed:', event.code, event.reason);
            // Only update state if it wasn't a normal closure
            if (event.code !== 1000) {
              updateTestState(testType, (prev) => ({
                ...prev,
                isRunning: false
              }));
            }
          }
        );

        // Store cleanup function
        wsCleanupRefs.current.set(execution.execution_id, cleanup);
        
      } else if (testType === 'ui') {
        console.log('[DEBUG] Running UI tests locally in the same container');
        // React tests: Run locally using vitest
        const execution_id = await testService.runUITestsWithStreaming(
          (message) => handleStreamMessage(testType, message),
          (error) => {
            console.error('UI test error:', error);
            updateTestState(testType, (prev) => ({
              ...prev,
              logs: [...prev.logs, `> Error: ${error.message}`],
              isRunning: false,
              exitCode: 1
            }));
            showToast('React test execution error', 'error');
          },
          () => {
            console.log('UI tests completed');
          }
        );

        // Update state with execution info
        updateTestState(testType, (prev) => ({
          ...prev,
          execution: {
            execution_id,
            test_type: 'ui',
            status: 'running',
            start_time: new Date().toISOString()
          },
          logs: [...prev.logs, `> Execution ID: ${execution_id}`, '> Running tests locally...']
        }));
      }

    } catch (error) {
      console.error(`[DEBUG] Failed to run ${testType} tests:`, error);
      console.error('[DEBUG] Error stack:', error instanceof Error ? error.stack : 'No stack');
      updateTestState(testType, (prev) => ({
        ...prev,
        logs: [...prev.logs, `> Error: ${error instanceof Error ? error.message : 'Unknown error'}`],
        isRunning: false,
        exitCode: 1
      }));
      showToast(`Failed to run ${testType} tests`, 'error');
    }
  };

  const cancelTest = async (testType: TestType) => {
    const currentState = testType === 'mcp' ? mcpTest : uiTest;
    
    if (currentState.execution?.execution_id) {
      try {
        await testService.cancelTestExecution(currentState.execution.execution_id);
        
        // Clean up WebSocket connection
        const cleanup = wsCleanupRefs.current.get(currentState.execution.execution_id);
        if (cleanup) {
          cleanup();
          wsCleanupRefs.current.delete(currentState.execution.execution_id);
        }
        
        updateTestState(testType, (prev) => ({
          ...prev,
          logs: [...prev.logs, '> Test execution cancelled by user'],
          isRunning: false,
          exitCode: -1
        }));

        showToast(`${testType.toUpperCase()} test execution cancelled`, 'success');
      } catch (error) {
        console.error(`Failed to cancel ${testType} tests:`, error);
        showToast(`Failed to cancel ${testType} tests`, 'error');
      }
    }
  };

  const getStatusIcon = (testState: TestExecutionState) => {
    if (testState.isRunning) {
      return <RefreshCw className="w-4 h-4 animate-spin text-orange-500" />;
    }
    if (testState.exitCode === 0) {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    if (testState.exitCode === -1) {
      return <Square className="w-4 h-4 text-gray-500" />;
    }
    if (testState.exitCode === 1) {
      return <XCircle className="w-4 h-4 text-red-500" />;
    }
    return <Clock className="w-4 h-4 text-gray-400" />;
  };

  const getStatusText = (testState: TestExecutionState) => {
    if (testState.isRunning) return 'Running...';
    if (testState.exitCode === 0) return 'Passed';
    if (testState.exitCode === -1) return 'Cancelled';
    if (testState.exitCode === 1) return 'Failed';
    return 'Ready';
  };

  const formatLogLine = (log: string, index: number) => {
    let textColor = 'text-gray-700 dark:text-gray-300';
    if (log.includes('PASS') || log.includes('✓') || log.includes('passed')) textColor = 'text-green-600 dark:text-green-400';
    if (log.includes('FAIL') || log.includes('✕') || log.includes('failed')) textColor = 'text-red-600 dark:text-red-400';
    if (log.includes('Error:') || log.includes('ERROR')) textColor = 'text-red-600 dark:text-red-400';
    if (log.includes('Warning:') || log.includes('WARN')) textColor = 'text-yellow-600 dark:text-yellow-400';
    if (log.includes('Status:') || log.includes('Duration:') || log.includes('Execution ID:')) textColor = 'text-cyan-600 dark:text-cyan-400';
    if (log.startsWith('>')) textColor = 'text-blue-600 dark:text-blue-400';

    return (
      <div key={index} className={`${textColor} py-0.5 whitespace-pre-wrap font-mono`}>
        {log}
      </div>
    );
  };

    const renderPrettyResults = (testState: TestExecutionState, testType: TestType) => {
    const hasErrors = testState.logs.some(log => log.includes('Error:') || log.includes('ERROR'));
    const isErrorsExpanded = testType === 'mcp' ? mcpErrorsExpanded : uiErrorsExpanded;
    const setErrorsExpanded = testType === 'mcp' ? setMcpErrorsExpanded : setUiErrorsExpanded;
    
    // Calculate available height for test results (when errors not expanded, use full height)
    const summaryHeight = testState.summary ? 44 : 0; // 44px for summary bar
    const runningHeight = (testState.isRunning && testState.results.length === 0) ? 36 : 0; // 36px for running indicator
    const errorHeaderHeight = hasErrors ? 32 : 0; // 32px for error header
    const availableHeight = isErrorsExpanded ? 0 : (256 - summaryHeight - runningHeight - errorHeaderHeight - 16); // When errors expanded, hide test results

    return (
      <div className="h-full flex flex-col relative">
        {/* Summary */}
        {testState.summary && (
          <div className="flex items-center gap-4 mb-3 p-2 bg-gray-800 rounded-md flex-shrink-0">
            <div className="text-xs">
              <span className="text-gray-400">Total: </span>
              <span className="text-white font-medium">{testState.summary.total}</span>
            </div>
            <div className="text-xs">
              <span className="text-gray-400">Passed: </span>
              <span className="text-green-400 font-medium">{testState.summary.passed}</span>
            </div>
            <div className="text-xs">
              <span className="text-gray-400">Failed: </span>
              <span className="text-red-400 font-medium">{testState.summary.failed}</span>
            </div>
            {testState.summary.skipped > 0 && (
              <div className="text-xs">
                <span className="text-gray-400">Skipped: </span>
                <span className="text-yellow-400 font-medium">{testState.summary.skipped}</span>
              </div>
            )}
          </div>
        )}

        {/* Running indicator */}
        {testState.isRunning && testState.results.length === 0 && (
          <div className="flex items-center gap-2 p-2 bg-gray-800 rounded-md mb-3 flex-shrink-0">
            <RefreshCw className="w-3 h-3 animate-spin text-orange-500" />
            <span className="text-gray-300 text-xs">Starting tests...</span>
          </div>
        )}

        {/* Test results - hidden when errors expanded */}
        {!isErrorsExpanded && (
          <div 
            ref={testType === 'mcp' ? mcpTerminalRef : uiTerminalRef}
            className="flex-1 overflow-y-auto" 
            style={{ maxHeight: `${availableHeight}px` }}
          >
            {testState.results.map((result, index) => (
              <div key={index} className="flex items-center gap-2 py-1 text-xs">
                {result.status === 'running' && <RefreshCw className="w-3 h-3 animate-spin text-orange-500 flex-shrink-0" />}
                {result.status === 'passed' && <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />}
                {result.status === 'failed' && <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />}
                {result.status === 'skipped' && <Square className="w-3 h-3 text-yellow-500 flex-shrink-0" />}
                
                <span className="flex-1 text-gray-700 dark:text-gray-300 font-mono text-xs truncate">{result.name}</span>
                
                {result.duration && (
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {result.duration.toFixed(2)}s
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Collapsible errors section */}
        {hasErrors && (
          <div 
            className={`transition-all duration-300 ease-in-out ${
              isErrorsExpanded ? 'absolute inset-0 flex flex-col' : 'flex-shrink-0 mt-auto -mx-4 -mb-4'
            }`}
          >
            {/* Error header with toggle */}
            <button
              onClick={() => setErrorsExpanded(!isErrorsExpanded)}
              className="w-full flex items-center justify-between p-2 bg-red-100/80 dark:bg-red-900/20 border border-red-300 dark:border-red-800 hover:bg-red-200 dark:hover:bg-red-900/30 transition-all duration-300 ease-in-out flex-shrink-0"
            >
              <div className="flex items-center gap-2">
                <XCircle className="w-3 h-3 text-red-600 dark:text-red-400" />
                <h4 className="text-xs font-medium text-red-600 dark:text-red-400">
                  Errors ({testState.logs.filter(log => log.includes('Error:') || log.includes('ERROR')).length})
                </h4>
              </div>
              <div className={`transform transition-transform duration-300 ease-in-out ${isErrorsExpanded ? 'rotate-180' : ''}`}>
                <ChevronUp className="w-4 h-4 text-red-600 dark:text-red-400" />
              </div>
            </button>
            
            {/* Collapsible error content */}
            <div 
              className={`bg-red-50 dark:bg-red-900/20 border-x border-b border-red-300 dark:border-red-800 overflow-hidden transition-all duration-300 ease-in-out ${
                isErrorsExpanded ? 'flex-1' : 'h-0'
              }`}
            >
              <div className="h-full overflow-y-auto p-2 space-y-2">
                {testState.logs
                  .filter(log => log.includes('Error:') || log.includes('ERROR') || log.includes('FAILED') || log.includes('AssertionError') || log.includes('Traceback'))
                  .map((log, index) => {
                    const isMainError = log.includes('ERROR:') || log.includes('FAILED');
                    const isAssertion = log.includes('AssertionError');
                    const isTraceback = log.includes('Traceback') || log.includes('File "');
                    
                    return (
                      <div key={index} className={`p-2 rounded ${
                        isMainError ? 'bg-red-200/80 dark:bg-red-800/30 border-l-4 border-red-500' :
                        isAssertion ? 'bg-red-100/80 dark:bg-red-700/20 border-l-2 border-red-400' :
                        isTraceback ? 'bg-gray-100 dark:bg-gray-800/50 border-l-2 border-gray-500' :
                        'bg-red-50 dark:bg-red-900/10'
                      }`}>
                        <div className="text-red-700 dark:text-red-300 text-xs font-mono whitespace-pre-wrap break-words">
                          {log}
                        </div>
                        {isMainError && (
                          <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                            <span className="font-medium">Error Type:</span> {
                              log.includes('Health_check') ? 'Health Check Failure' :
                              log.includes('AssertionError') ? 'Test Assertion Failed' :
                              log.includes('NoneType') ? 'Null Reference Error' :
                              'General Error'
                            }
                          </div>
                        )}
                      </div>
                    );
                  })}
                
                {/* Error summary */}
                <div className="mt-4 p-2 bg-red-100/80 dark:bg-red-900/30 rounded border border-red-300 dark:border-red-700">
                  <h5 className="text-red-600 dark:text-red-400 font-medium text-xs mb-2">Error Summary:</h5>
                  <div className="text-xs text-red-700 dark:text-red-300 space-y-1">
                    <div>Total Errors: {testState.logs.filter(log => log.includes('ERROR:') || log.includes('FAILED')).length}</div>
                    <div>Assertion Failures: {testState.logs.filter(log => log.includes('AssertionError')).length}</div>
                    <div>Test Type: {testType === 'mcp' ? 'Python MCP Tools' : 'React UI Components'}</div>
                    <div>Status: Failed</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const TestSection = ({ 
    title, 
    testType, 
    testState, 
    onRun, 
    onCancel 
  }: { 
    title: string; 
    testType: TestType; 
    testState: TestExecutionState; 
    onRun: () => void; 
    onCancel: () => void; 
  }) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-md font-medium text-gray-700 dark:text-gray-300">
            {title}
          </h3>
          {getStatusIcon(testState)}
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {getStatusText(testState)}
          </span>
          {testState.duration && (
            <span className="text-xs text-gray-400">
              ({testState.duration.toFixed(1)}s)
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {/* Test Results button for React UI tests only */}
          {testType === 'ui' && hasResults && !testState.isRunning && (
            <Button
              variant="outline"
              accentColor="blue"
              size="sm"
              onClick={() => setShowTestResultsModal(true)}
            >
              <BarChart className="w-4 h-4 mr-2" />
              Test Results
            </Button>
          )}
          {testState.isRunning ? (
            <Button
              variant="outline"
              accentColor="pink"
              size="sm"
              onClick={onCancel}
            >
              <Square className="w-4 h-4 mr-2" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="primary"
              accentColor="orange"
              size="sm"
              onClick={onRun}
              className="shadow-lg shadow-orange-500/20"
            >
              <Play className="w-4 h-4 mr-2" />
              Run Tests
            </Button>
          )}
        </div>
      </div>
      
      <div className="bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md p-4 h-64 relative">
        {renderPrettyResults(testState, testType)}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setIsCollapsed(!isCollapsed)}>
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-orange-500 dark:text-orange-400 filter drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]" />
          <h2 className="text-xl font-semibold text-gray-800 dark:text-white">Archon Unit Tests</h2>
          <div className={`transform transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`}>
            <ChevronDown className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </div>
        </div>
        
        {/* Display mode toggle - only visible when expanded */}
        {!isCollapsed && (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Button
              variant={displayMode === 'pretty' ? 'primary' : 'outline'}
              accentColor="blue"
              size="sm"
              onClick={() => setDisplayMode('pretty')}
            >
              <CheckCircle className="w-4 h-4 mr-1" />
              Summary
            </Button>
            <Button
              variant={displayMode === 'dashboard' ? 'primary' : 'outline'}
              accentColor="blue"
              size="sm"
              onClick={() => setDisplayMode('dashboard')}
            >
              <BarChart className="w-4 h-4 mr-1" />
              Dashboard
            </Button>
          </div>
        )}
      </div>

      {/* Collapsible content */}
      <div className={`space-y-4 transition-all duration-300 ${isCollapsed ? 'hidden' : 'block'}`}>
        {displayMode === 'pretty' ? (
          <>
            <TestSection
              title="Python Tests"
              testType="mcp"
              testState={mcpTest}
              onRun={() => runTest('mcp')}
              onCancel={() => cancelTest('mcp')}
            />

            <TestSection
              title="React UI Tests"
              testType="ui"
              testState={uiTest}
              onRun={() => runTest('ui')}
              onCancel={() => cancelTest('ui')}
            />
          </>
        ) : (
          <TestResultDashboard 
            className="mt-6"
            compact={false}
            showCoverage={true}
            refreshInterval={30}
          />
        )}
      </div>

      {/* Test Results Modal */}
      <TestResultsModal 
        isOpen={showTestResultsModal} 
        onClose={() => setShowTestResultsModal(false)} 
      />
    </div>
  );
};