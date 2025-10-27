import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../primitives";
import { cn, glassmorphism } from "../primitives/styles";

interface Props {
  children: ReactNode;
  featureName: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class FeatureErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log detailed error information for debugging in dev/test
    if (import.meta.env.DEV || import.meta.env.MODE === "test") {
      console.error(`Feature Error in ${this.props.featureName}:`, {
        error,
        errorInfo,
        componentStack: errorInfo.componentStack,
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString(),
      });
    }

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const { error, errorInfo } = this.state;
      const isDevelopment = process.env.NODE_ENV === "development";

      return (
        <div className={cn("min-h-[400px] flex items-center justify-center p-8", glassmorphism.background.subtle)}>
          <div className="max-w-2xl w-full">
            <div className="flex items-start gap-4" role="alert" aria-live="assertive" aria-atomic="true">
              <div
                className={cn(
                  "p-3 rounded-lg",
                  "bg-red-500/10 dark:bg-red-500/20",
                  "border border-red-500/20 dark:border-red-500/30",
                )}
              >
                <AlertTriangle
                  className="w-6 h-6 text-red-600 dark:text-red-400"
                  aria-hidden="true"
                  focusable="false"
                />
              </div>

              <div className="flex-1">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                  Feature Error: {this.props.featureName}
                </h2>

                <p className="text-gray-700 dark:text-gray-300 mb-4">
                  An error occurred in this feature. The error has been logged for investigation.
                </p>

                {/* Show detailed error in development */}
                {isDevelopment && error && (
                  <div
                    className={cn(
                      "mb-4 p-4 rounded-lg overflow-auto max-h-[300px]",
                      "bg-gray-100 dark:bg-gray-800",
                      "border border-gray-300 dark:border-gray-600",
                      "font-mono text-xs",
                    )}
                  >
                    <div className="text-red-600 dark:text-red-400 font-semibold mb-2">{error.toString()}</div>
                    {error.stack && (
                      <pre className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{error.stack}</pre>
                    )}
                    {errorInfo?.componentStack && (
                      <div className="mt-4 pt-4 border-t border-gray-300 dark:border-gray-600">
                        <div className="text-gray-700 dark:text-gray-300 font-semibold mb-2">Component Stack:</div>
                        <pre className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">
                          {errorInfo.componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                <Button onClick={this.handleReset} variant="default" size="sm" className="gap-2">
                  <RefreshCw className="w-4 h-4" />
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
