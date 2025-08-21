/**
 * Error Boundary Component with React 18 Features
 * Provides fallback UI and error recovery options
 */

import React, { Component, ErrorInfo, ReactNode, Suspense } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorCount: number;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, errorInfo: ErrorInfo, reset: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  resetKeys?: Array<string | number>;
  resetOnPropsChange?: boolean;
  isolate?: boolean;
  level?: 'page' | 'section' | 'component';
}

/**
 * Enhanced Error Boundary with recovery options
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private resetTimeoutId: NodeJS.Timeout | null = null;
  private previousResetKeys: Array<string | number> = [];

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { onError } = this.props;
    
    // Log error details
    console.error('Error caught by boundary:', error);
    console.error('Error info:', errorInfo);
    
    // Update state with error details
    this.setState(prevState => ({
      errorInfo,
      errorCount: prevState.errorCount + 1
    }));
    
    // Call error handler if provided
    if (onError) {
      onError(error, errorInfo);
    }
    
    // In alpha, we want to fail fast and require explicit user action
    // Log detailed error information for debugging
    console.error('[ErrorBoundary] Component error caught:', {
      error: error.toString(),
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      errorCount: this.state.errorCount + 1,
      isolate: this.props.isolate
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { resetKeys, resetOnPropsChange } = this.props;
    const { hasError } = this.state;
    
    // Reset on prop changes if enabled
    if (hasError && prevProps.children !== this.props.children && resetOnPropsChange) {
      this.reset();
    }
    
    // Reset on resetKeys change
    if (hasError && resetKeys && this.previousResetKeys !== resetKeys) {
      const hasResetKeyChanged = resetKeys.some(
        (key, index) => key !== this.previousResetKeys[index]
      );
      
      if (hasResetKeyChanged) {
        this.reset();
      }
    }
    
    this.previousResetKeys = resetKeys || [];
  }

  componentWillUnmount(): void {
    if (this.resetTimeoutId) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
  }

  reset = (): void => {
    if (this.resetTimeoutId) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
    
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, errorCount } = this.state;
    const { children, fallback, level = 'component' } = this.props;
    
    if (hasError && error && errorInfo) {
      // Use custom fallback if provided
      if (fallback) {
        return fallback(error, errorInfo, this.reset);
      }
      
      // Default fallback UI based on level
      return <DefaultErrorFallback
        error={error}
        errorInfo={errorInfo}
        reset={this.reset}
        level={level}
        errorCount={errorCount}
      />;
    }
    
    return children;
  }
}

/**
 * Default error fallback component
 */
interface DefaultErrorFallbackProps {
  error: Error;
  errorInfo: ErrorInfo;
  reset: () => void;
  level: 'page' | 'section' | 'component';
  errorCount: number;
}

const DefaultErrorFallback: React.FC<DefaultErrorFallbackProps> = ({
  error,
  errorInfo,
  reset,
  level,
  errorCount
}) => {
  const isPageLevel = level === 'page';
  const isSectionLevel = level === 'section';
  
  if (level === 'component') {
    // Minimal component-level error
    return (
      <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <span className="text-sm text-red-700 dark:text-red-300">
            Component error occurred
          </span>
          <button
            onClick={reset}
            className="ml-auto text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`
      ${isPageLevel ? 'min-h-screen' : isSectionLevel ? 'min-h-[400px]' : 'min-h-[200px]'}
      flex items-center justify-center p-8
      bg-gradient-to-br from-red-50 to-orange-50 
      dark:from-gray-900 dark:to-gray-800
    `}>
      <div className="max-w-2xl w-full">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          {/* Error Icon */}
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-red-100 dark:bg-red-900/30 rounded-full">
              <AlertTriangle className="w-12 h-12 text-red-500" />
            </div>
          </div>
          
          {/* Error Title */}
          <h1 className="text-2xl font-bold text-center text-gray-900 dark:text-white mb-2">
            {isPageLevel ? 'Something went wrong' : 'An error occurred'}
          </h1>
          
          {/* Error Message */}
          <p className="text-center text-gray-600 dark:text-gray-400 mb-6">
            {error.message || 'An unexpected error occurred while rendering this component.'}
          </p>
          
          {/* Retry Count */}
          {errorCount > 1 && (
            <p className="text-center text-sm text-gray-500 dark:text-gray-500 mb-4">
              This error has occurred {errorCount} times
            </p>
          )}
          
          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={reset}
              className="
                flex items-center justify-center gap-2 px-6 py-3
                bg-blue-500 hover:bg-blue-600 
                text-white font-medium rounded-lg
                transition-colors duration-150
              "
            >
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
            
            {isPageLevel && (
              <button
                onClick={() => window.location.href = '/'}
                className="
                  flex items-center justify-center gap-2 px-6 py-3
                  bg-gray-200 hover:bg-gray-300 
                  dark:bg-gray-700 dark:hover:bg-gray-600
                  text-gray-700 dark:text-gray-200 font-medium rounded-lg
                  transition-colors duration-150
                "
              >
                <Home className="w-4 h-4" />
                Go Home
              </button>
            )}
          </div>
          
          {/* Error Details (Development Only) */}
          {process.env.NODE_ENV === 'development' && (
            <details className="mt-8 p-4 bg-gray-100 dark:bg-gray-900 rounded-lg">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
                Error Details (Development Only)
              </summary>
              <div className="mt-4 space-y-2">
                <div>
                  <p className="text-xs font-mono text-gray-600 dark:text-gray-400">
                    {error.stack}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-500">
                    Component Stack:
                  </p>
                  <p className="text-xs font-mono text-gray-600 dark:text-gray-400">
                    {errorInfo.componentStack}
                  </p>
                </div>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Suspense Error Boundary - combines Suspense with Error Boundary
 */
interface SuspenseErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  errorFallback?: (error: Error, errorInfo: ErrorInfo, reset: () => void) => ReactNode;
  level?: 'page' | 'section' | 'component';
}

export const SuspenseErrorBoundary: React.FC<SuspenseErrorBoundaryProps> = ({
  children,
  fallback,
  errorFallback,
  level = 'component'
}) => {
  const defaultFallback = (
    <div className="flex items-center justify-center p-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
    </div>
  );
  
  return (
    <ErrorBoundary fallback={errorFallback} level={level}>
      <Suspense fallback={fallback || defaultFallback}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
};

/**
 * Hook to reset error boundaries
 */
export function useErrorHandler(): (error: Error) => void {
  return (error: Error) => {
    throw error;
  };
}