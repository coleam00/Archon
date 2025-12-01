import { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle, Bug, RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { BugReportModal } from "./BugReportModal";
import { bugReportService, BugContext } from "../../services/bugReportService";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, errorInfo: ErrorInfo) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showBugReport: boolean;
  bugContext: BugContext | null;
}

export class ErrorBoundaryWithBugReport extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showBugReport: false,
      bugContext: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // Collect bug context automatically when error occurs
    this.collectBugContext(error);
  }

  private async collectBugContext(error: Error) {
    try {
      const context = await bugReportService.collectBugContext(error);
      this.setState({ bugContext: context });
    } catch (contextError) {
      console.error("Failed to collect bug context:", contextError);
    }
  }

  private handleReportBug = () => {
    this.setState({ showBugReport: true });
  };

  private handleCloseBugReport = () => {
    this.setState({ showBugReport: false });
  };

  private handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showBugReport: false,
      bugContext: null,
    });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError && this.state.error) {
      // Custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.state.errorInfo!);
      }

      // Default error UI
      return (
        <>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
            <Card className="max-w-lg w-full">
              <div className="p-6 text-center">
                {/* Error Icon */}
                <div className="w-16 h-16 mx-auto mb-4 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center">
                  <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
                </div>

                {/* Error Title */}
                <h1 className="text-xl font-bold text-gray-800 dark:text-white mb-2">
                  Something went wrong
                </h1>

                {/* Error Message */}
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  {this.state.error.message}
                </p>

                {/* Error Details (collapsible) */}
                <details className="text-left mb-6">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-sm">
                    Technical details
                  </summary>
                  <div className="mt-2 p-3 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono overflow-auto max-h-32">
                    <div className="mb-2">
                      <strong>Error:</strong> {this.state.error.name}
                    </div>
                    <div className="mb-2">
                      <strong>Message:</strong> {this.state.error.message}
                    </div>
                    {this.state.error.stack && (
                      <div>
                        <strong>Stack:</strong>
                        <pre className="mt-1 whitespace-pre-wrap">
                          {this.state.error.stack}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>

                {/* Action Buttons */}
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <Button onClick={this.handleRetry} variant="ghost">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Try Again
                  </Button>

                  <Button onClick={this.handleReload} variant="ghost">
                    Reload Page
                  </Button>

                  <Button
                    onClick={this.handleReportBug}
                    className="bg-red-600 hover:bg-red-700 text-white"
                    disabled={!this.state.bugContext}
                  >
                    <Bug className="w-4 h-4 mr-2" />
                    Report Bug
                  </Button>
                </div>

                {/* Help Text */}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-6">
                  If this keeps happening, please report the bug so we can fix
                  it.
                </p>
              </div>
            </Card>
          </div>

          {/* Bug Report Modal */}
          {this.state.bugContext && (
            <BugReportModal
              isOpen={this.state.showBugReport}
              onClose={this.handleCloseBugReport}
              context={this.state.bugContext}
            />
          )}
        </>
      );
    }

    return this.props.children;
  }
}
