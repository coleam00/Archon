// Test execution types
export type TestType = 'mcp' | 'ui';

export interface TestExecution {
  execution_id: string;
  test_type: TestType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  start_time: string;
  end_time?: string;
  duration?: number;
  exit_code?: number;
  output?: string[];
}

export interface TestExecutionRequest {
  test_type: TestType;
  options?: Record<string, any>;
}

export interface TestStreamMessage {
  type: 'status' | 'output' | 'completed' | 'error' | 'cancelled';
  execution_id: string;
  data?: any;
  message?: string;
  timestamp: string;
}

export interface TestHistory {
  executions: TestExecution[];
  total_count: number;
}

export interface TestStatus {
  execution_id: string;
  status: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  exit_code?: number;
}

import { getApiUrl, getWebSocketUrl } from '../config/api';
import { v4 as uuidv4 } from 'uuid';

// Use unified API configuration
const API_BASE_URL = getApiUrl();

// Error class for test service errors
export class TestServiceError extends Error {
  constructor(message: string, public code: string, public statusCode?: number) {
    super(message);
    this.name = 'TestServiceError';
  }
}

// Helper function to call FastAPI endpoints directly
async function callAPI<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options
    });

    if (!response.ok) {
      throw new TestServiceError(
        `HTTP error! status: ${response.status}`, 
        'HTTP_ERROR', 
        response.status
      );
    }

    const result = await response.json();
    
    // Check if response has error field (from FastAPI error format)
    if (result.error) {
      throw new TestServiceError(
        result.error, 
        'API_ERROR',
        response.status
      );
    }

    return result as T;
  } catch (error) {
    if (error instanceof TestServiceError) {
      throw error;
    }
    
    throw new TestServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      500
    );
  }
}

class TestService {
  private wsConnections: Map<string, WebSocket> = new Map();

  /**
   * Execute Python tests using pytest via backend API
   */
  async runMCPTests(): Promise<TestExecution> {
    const requestBody: TestExecutionRequest = {
      test_type: 'mcp',
      options: {}
    };

    const response = await callAPI<TestExecution>('/api/tests/mcp/run', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });
    return response;
  }

  /**
   * Execute React UI tests via backend API (runs in Docker container)
   */
  async runUITests(): Promise<TestExecution> {
    console.log('[DEBUG TestService] runUITests called');
    const requestBody: TestExecutionRequest = {
      test_type: 'ui',
      options: {}
    };
    console.log('[DEBUG TestService] Request body:', requestBody);

    try {
      const response = await callAPI<TestExecution>('/api/tests/ui/run', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });
      console.log('[DEBUG TestService] UI test response:', response);
      return response;
    } catch (error) {
      console.error('[DEBUG TestService] UI test API call failed:', error);
      throw error;
    }
  }

  /**
   * Run React tests locally using the Vite dev server endpoint and stream output
   */
  async runUITestsWithStreaming(
    onMessage: (message: TestStreamMessage) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void
  ): Promise<string> {
    return this.runTestsWithEndpoint('/api/run-tests-with-coverage', onMessage, onError, onComplete);
  }

  /**
   * Generic method to run tests with any endpoint
   */
  private async runTestsWithEndpoint(
    endpoint: string,
    onMessage: (message: TestStreamMessage) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void
  ): Promise<string> {
    const execution_id = uuidv4();
    
    try {
      // Send initial status
      onMessage({
        type: 'status',
        execution_id,
        data: { status: 'running' },
        message: 'Starting React UI tests with coverage...',
        timestamp: new Date().toISOString()
      });

      // Call the Vite dev server endpoint to run real vitest tests
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to start tests: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader available');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              // Forward the real test output with our execution_id
              onMessage({
                ...data,
                execution_id
              });
              
              if (data.type === 'completed') {
                onComplete?.();
                return execution_id;
              }
              
              if (data.type === 'error') {
                onError?.(new Error(data.message));
                return execution_id;
              }
            } catch (e) {
              console.warn('Failed to parse SSE message:', line);
            }
          }
        }
      }

      return execution_id;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      onMessage({
        type: 'error',
        execution_id,
        message: errorMessage,
        timestamp: new Date().toISOString()
      });
      onError?.(error instanceof Error ? error : new Error(errorMessage));
      return execution_id;
    }
  }


  /**
   * Get coverage data for Test Results Modal from new API endpoints with fallback
   */
  async getCoverageData(): Promise<any> {
    const response = await fetch('/test-results/coverage/coverage-summary.json');
    if (!response.ok) {
      throw new Error('Coverage data not available');
    }
    return await response.json();
  }

  /**
   * Get test results for Test Results Modal from new API endpoints with fallback
   */
  async getTestResults(): Promise<any> {
    const response = await fetch('/test-results/test-results.json');
    if (!response.ok) {
      throw new Error('Test results not available');
    }
    const data = await response.json();

    // Transform the data to match the expected TestResults interface
    const transformedData = {
      summary: {
        total: data.numTotalTests || 0,
        passed: data.numPassedTests || 0,
        failed: data.numFailedTests || 0,
        skipped: data.numPendingTests || 0,
        duration: data.testResults.reduce((acc: number, suite: any) => acc + (suite.endTime - suite.startTime), 0),
      },
      suites: data.testResults.map((suite: any) => ({
        name: suite.name,
        tests: suite.assertionResults.length,
        passed: suite.assertionResults.filter((r: any) => r.status === 'passed').length,
        failed: suite.assertionResults.filter((r: any) => r.status === 'failed').length,
        skipped: suite.assertionResults.filter((r: any) => r.status === 'pending' || r.status === 'todo').length,
        duration: suite.endTime - suite.startTime,
        failedTests: suite.assertionResults
          .filter((r: any) => r.status === 'failed')
          .map((r: any) => ({ name: r.title, error: r.failureMessages.join('\\n') }))
      })),
      timestamp: new Date(data.startTime).toISOString()
    };

    return transformedData;
  }

  /**
   * Get pytest coverage data specifically
   */
  async getPytestCoverage(): Promise<any> {
    try {
      const response = await callAPI<any>('/api/coverage/pytest/json');
      return response;
    } catch (error) {
      throw new Error(`Failed to load pytest coverage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get vitest coverage data specifically
   */
  async getVitestCoverage(): Promise<any> {
    try {
      const response = await callAPI<any>('/api/coverage/vitest/summary');
      return response;
    } catch (error) {
      throw new Error(`Failed to load vitest coverage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get URL for coverage HTML report
   */
  getCoverageHtmlUrl(): string {
    // Return URL to pytest coverage HTML report via new API endpoint
    return '/api/coverage/pytest/html/index.html';
  }

  /**
   * Get URL for vitest coverage HTML report
   */
  getVitestCoverageHtmlUrl(): string {
    // Return URL to vitest coverage HTML report via new API endpoint
    return '/api/coverage/vitest/html/index.html';
  }

  /**
   * Get test execution status
   */
  async getTestStatus(executionId: string): Promise<TestStatus> {
    const response = await callAPI<TestStatus>(`/api/tests/status/${executionId}`);
    return response;
  }

  /**
   * Get test execution history
   */
  async getTestHistory(): Promise<TestHistory> {
    const response = await callAPI<TestHistory>('/api/tests/history');
    return response;
  }

  /**
   * Cancel a running test execution
   */
  async cancelTestExecution(executionId: string): Promise<void> {
    await callAPI<void>(`/api/tests/execution/${executionId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Connect to WebSocket stream for real-time test output
   */
  connectToTestStream(
    executionId: string,
    onMessage: (message: TestStreamMessage) => void,
    onError?: (error: Event) => void,
    onClose?: (event: CloseEvent) => void
  ): () => void {
    // Clean up any existing connection
    this.disconnectFromTestStream(executionId);

    const wsUrl = getWebSocketUrl() + `/api/tests/stream/${executionId}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`Connected to test stream: ${executionId}`);
    };

    ws.onmessage = (event) => {
      try {
        const message: TestStreamMessage = JSON.parse(event.data);
        onMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error, event.data);
      }
    };

    ws.onerror = (error) => {
      console.error(`WebSocket error for test ${executionId}:`, error);
      if (onError) {
        onError(error);
      }
    };

    ws.onclose = (event) => {
      console.log(`WebSocket closed for test ${executionId}:`, event.code, event.reason);
      this.wsConnections.delete(executionId);
      if (onClose) {
        onClose(event);
      }
    };

    // Store the connection
    this.wsConnections.set(executionId, ws);

    // Return cleanup function
    return () => this.disconnectFromTestStream(executionId);
  }

  /**
   * Disconnect from WebSocket stream
   */
  disconnectFromTestStream(executionId: string): void {
    const ws = this.wsConnections.get(executionId);
    if (ws) {
      ws.close();
      this.wsConnections.delete(executionId);
    }
  }

  /**
   * Disconnect all WebSocket connections
   */
  disconnectAllStreams(): void {
    this.wsConnections.forEach((ws) => {
      ws.close();
    });
    this.wsConnections.clear();
  }

  /**
   * Check if a test stream is connected
   */
  isStreamConnected(executionId: string): boolean {
    const ws = this.wsConnections.get(executionId);
    return ws ? ws.readyState === WebSocket.OPEN : false;
  }
}

// Export singleton instance
export const testService = new TestService();
export default testService; 