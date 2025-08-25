import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  TestTube, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Activity, 
  TrendingUp, 
  RefreshCw,
  BarChart,
  AlertTriangle,
  Target,
  Zap
} from 'lucide-react';
import { CoverageVisualization, CoverageData } from './CoverageVisualization';
import { testService } from '../../services/testService';

export interface TestResults {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  };
  suites: Array<{
    name: string;
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
    failedTests?: Array<{
      name: string;
      error?: string;
    }>;
  }>;
  timestamp?: string;
}

interface TestResultDashboardProps {
  className?: string;
  compact?: boolean;
  showCoverage?: boolean;
  refreshInterval?: number; // Auto-refresh interval in seconds
}

interface TestSummaryCardProps {
  results: TestResults | null;
  isLoading?: boolean;
}

const TestSummaryCard: React.FC<TestSummaryCardProps> = ({ results, isLoading }) => {
  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <Activity className="w-5 h-5 animate-pulse text-blue-500" />
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
            Loading Test Results...
          </h3>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const summary = results?.summary;

  if (!summary) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <TestTube className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4" />
          <h3 className="text-lg font-medium text-gray-500 dark:text-gray-400 mb-2">
            No Test Results Available
          </h3>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            Run tests to see detailed results and metrics
          </p>
        </div>
      </div>
    );
  }

  const safeSummary = {
    total: summary.total || 0,
    passed: summary.passed || 0,
    failed: summary.failed || 0,
    skipped: summary.skipped || 0,
    duration: summary.duration || 0,
  };

  const successRate = safeSummary.total > 0 ? (safeSummary.passed / safeSummary.total) * 100 : 0;

  const getHealthStatus = () => {
    if (safeSummary.failed === 0 && safeSummary.passed > 0) return { text: 'All Tests Passing', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-900/20' };
    if (successRate >= 80) return { text: 'Mostly Passing', color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-900/20' };
    return { text: 'Tests Failing', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20' };
  };

  const health = getHealthStatus();

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow duration-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <TestTube className="w-6 h-6 text-blue-500" />
          <h3 className="text-xl font-semibold text-gray-800 dark:text-white">
            Test Summary
          </h3>
        </div>
        <div className={`px-3 py-1 rounded-full text-sm font-medium ${health.bg} ${health.color}`}>
          {health.text}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="text-center p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
        >
          <div className="text-2xl font-bold text-gray-800 dark:text-white mb-1">
            {safeSummary.total}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Tests</div>
        </motion.div>

        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800"
        >
          <div className="text-2xl font-bold text-green-600 dark:text-green-400 mb-1 flex items-center justify-center gap-1">
            <CheckCircle className="w-5 h-5" />
            {safeSummary.passed}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Passed</div>
        </motion.div>

        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800"
        >
          <div className="text-2xl font-bold text-red-600 dark:text-red-400 mb-1 flex items-center justify-center gap-1">
            <XCircle className="w-5 h-5" />
            {safeSummary.failed}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Failed</div>
        </motion.div>

        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="text-center p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800"
        >
          <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400 mb-1 flex items-center justify-center gap-1">
            <Clock className="w-5 h-5" />
            {safeSummary.skipped}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Skipped</div>
        </motion.div>
      </div>

      {/* Success Rate Progress Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Success Rate</span>
          <span className="text-sm text-gray-600 dark:text-gray-400">{successRate.toFixed(1)}%</span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${successRate}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
            className={`h-3 rounded-full ${
              successRate >= 90 ? 'bg-green-500' :
              successRate >= 70 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
          />
        </div>
      </div>

      {/* Additional Stats */}
      <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4" />
          <span>Duration: {(safeSummary.duration / 1000).toFixed(2)}s</span>
        </div>
        {results.timestamp && (
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4" />
            <span>Last run: {new Date(results.timestamp).toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      {/* Failed Tests Alert */}
      {safeSummary.failed > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
        >
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm font-medium">
              {safeSummary.failed} test{safeSummary.failed > 1 ? 's' : ''} failing - review errors below
            </span>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
};

const FailedTestsList: React.FC<{ results: TestResults }> = ({ results }) => {
  if (!results || !Array.isArray(results.suites) || !results.summary) {
    return null;
  }
  const failedSuites = results.suites.filter(suite => suite && typeof suite.failed === 'number' && suite.failed > 0);
  
  if (failedSuites.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-red-200 dark:border-red-800 shadow-sm"
    >
      <div className="flex items-center gap-3 mb-4">
        <XCircle className="w-5 h-5 text-red-500" />
        <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
          Failed Tests ({results?.summary?.failed || 0})
        </h3>
      </div>

      <div className="space-y-4 max-h-96 overflow-y-auto">
        {failedSuites.map((suite, suiteIndex) => (
          <div key={suiteIndex} className="border border-gray-200 dark:border-gray-700 rounded-lg">
            <div className="p-3 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-gray-700 dark:text-gray-300">
                  {suite.name.split('/').pop()}
                </span>
                <span className="text-xs text-red-600 dark:text-red-400">
                  {suite.failed} failed
                </span>
              </div>
            </div>
            
            {suite.failedTests && (
              <div className="p-3 space-y-2">
                {suite.failedTests.map((test, testIndex) => (
                  <div key={testIndex} className="pl-3 border-l-2 border-red-200 dark:border-red-800">
                    <div className="text-sm font-medium text-red-700 dark:text-red-400 mb-1">
                      {test.name}
                    </div>
                    {test.error && (
                      <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-mono bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto">
                        {test.error.length > 300 ? `${test.error.substring(0, 300)}...` : test.error}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  );
};

export const TestResultDashboard: React.FC<TestResultDashboardProps> = ({
  className = '',
  compact = false,
  showCoverage = true,
  refreshInterval
}) => {
  const [results, setResults] = useState<TestResults | null>(null);
  const [coverage, setCoverage] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadTestData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Load test results and coverage data
      const [testResults, coverageData] = await Promise.allSettled([
        testService.getTestResults(),
        showCoverage ? testService.getCoverageData() : Promise.resolve(null)
      ]);

      if (testResults.status === 'fulfilled') {
        setResults(testResults.value);
      } else {
        console.warn('Failed to load test results:', testResults.reason);
      }

      if (coverageData.status === 'fulfilled' && coverageData.value) {
        setCoverage(coverageData.value);
      } else if (showCoverage) {
        console.warn('Failed to load coverage data:', coverageData.status === 'rejected' ? coverageData.reason : 'No data');
      }

      setLastRefresh(new Date());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load test data';
      setError(message);
      console.error('Test data loading error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadTestData();
  }, [showCoverage]);

  // Auto-refresh
  useEffect(() => {
    if (!refreshInterval) return;

    const interval = setInterval(loadTestData, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval, showCoverage]);

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Target className="w-6 h-6 text-blue-500" />
          <h2 className="text-2xl font-bold text-gray-800 dark:text-white">
            Test Results Dashboard
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={loadTestData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4"
        >
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <span className="font-medium">Failed to load test data: {error}</span>
          </div>
        </motion.div>
      )}

      {/* Main content */}
      <div className={`grid gap-6 ${compact ? 'grid-cols-1' : 'grid-cols-1'}`}>
        {/* Test Summary */}
        <div className="flex-1">
          <TestSummaryCard results={results} isLoading={loading && !results} />
        </div>

        {/* Coverage Visualization */}
        {showCoverage && (
          <div>
            <CoverageVisualization 
              coverage={coverage} 
              compact={compact}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm p-6"
            />
          </div>
        )}
      </div>

      {/* Failed Tests */}
      {results?.summary?.failed > 0 && results?.suites && (
        <FailedTestsList results={results} />
      )}
    </div>
  );
};

export default TestResultDashboard;