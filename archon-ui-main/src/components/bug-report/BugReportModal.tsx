import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bug, X, Send, Copy, ExternalLink, Loader } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Card } from "../ui/Card";
import { Select } from "../ui/Select";
import { useToast } from "../../features/shared/hooks/useToast";
import {
  bugReportService,
  BugContext,
  BugReportData,
} from "../../services/bugReportService";
import { copyToClipboard } from "../../features/shared/utils/clipboard";

interface BugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  context: BugContext;
}

export const BugReportModal: React.FC<BugReportModalProps> = ({
  isOpen,
  onClose,
  context,
}) => {
  const [report, setReport] = useState<Omit<BugReportData, "context">>({
    title: `🐛 ${context.error.name}: ${context.error.message}`,
    description: "",
    stepsToReproduce: "",
    expectedBehavior: "",
    actualBehavior: context.error.message,
    severity: "medium",
    component: "not-sure",
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!report.description.trim()) {
      showToast(
        "Please provide a description of what you were trying to do",
        "error",
      );
      return;
    }

    setSubmitting(true);

    try {
      const bugReportData: BugReportData = {
        ...report,
        context,
      };

      const result = await bugReportService.submitBugReport(bugReportData);

      if (result.success) {
        setSubmitted(true);

        if (result.issueNumber) {
          // Direct API creation (maintainer with token)
          showToast(
            `Bug report created! Issue #${result.issueNumber} - maintainers will review it soon.`,
            "success",
            8000,
          );
          if (result.issueUrl) {
            window.open(result.issueUrl, "_blank");
          }
        } else {
          // Manual submission (open source user - no token)
          showToast(
            "Opening GitHub to submit your bug report...",
            "success",
            5000,
          );
          if (result.issueUrl) {
            // Force new tab/window opening
            const newWindow = window.open(
              result.issueUrl,
              "_blank",
              "noopener,noreferrer",
            );
            if (!newWindow) {
              // Popup blocked - show manual link
              showToast(
                "Popup blocked! Please allow popups or click the link in the modal.",
                "warning",
                8000,
              );
            }
          }
        }
      } else {
        // Fallback: copy to clipboard
        const formattedReport =
          bugReportService.formatReportForClipboard(bugReportData);
        const clipboardResult = await copyToClipboard(formattedReport);

        if (clipboardResult.success) {
          showToast(
            "Failed to create GitHub issue, but bug report was copied to clipboard. Please paste it in a new GitHub issue.",
            "warning",
            10000,
          );
        } else {
          showToast(
            "Failed to create GitHub issue and could not copy to clipboard. Please report manually.",
            "error",
            10000,
          );
        }
      }
    } catch (error) {
      console.error("Bug report submission failed:", error);
      showToast(
        "Failed to submit bug report. Please try again or report manually.",
        "error",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyToClipboard = async () => {
    const bugReportData: BugReportData = { ...report, context };
    const formattedReport =
      bugReportService.formatReportForClipboard(bugReportData);

    const result = await copyToClipboard(formattedReport);
    if (result.success) {
      showToast("Bug report copied to clipboard", "success");
    } else {
      showToast("Failed to copy to clipboard", "error");
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="w-full max-w-2xl max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <Card className="relative">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3">
                <Bug className="w-6 h-6 text-red-500" />
                <h2 className="text-xl font-bold text-gray-800 dark:text-white">
                  Report Bug
                </h2>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {submitted ? (
              /* Success State */
              <div className="p-6 text-center">
                <div className="w-16 h-16 mx-auto mb-4 bg-green-100 dark:bg-green-900/20 rounded-full flex items-center justify-center">
                  <Bug className="w-8 h-8 text-green-600 dark:text-green-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-2">
                  Bug Report Submitted!
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Thank you for helping improve Archon. Maintainers will review
                  your report and may comment @claude to trigger automatic
                  analysis and fixes.
                </p>
                <Button onClick={onClose}>Close</Button>
              </div>
            ) : (
              /* Form */
              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {/* Error Preview */}
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
                  <div className="font-medium text-red-800 dark:text-red-200 text-sm">
                    {context.error.name}: {context.error.message}
                  </div>
                  {context.error.stack && (
                    <details className="mt-2">
                      <summary className="text-red-600 dark:text-red-400 text-xs cursor-pointer">
                        Stack trace
                      </summary>
                      <pre className="text-xs text-red-600 dark:text-red-400 mt-1 overflow-auto max-h-32">
                        {context.error.stack}
                      </pre>
                    </details>
                  )}
                </div>

                {/* Bug Title */}
                <Input
                  label="Bug Title"
                  value={report.title}
                  onChange={(e) =>
                    setReport((r) => ({ ...r, title: e.target.value }))
                  }
                  placeholder="Brief description of the bug"
                  required
                />

                {/* Severity & Component */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Select
                    label="Severity"
                    value={report.severity}
                    onChange={(e) =>
                      setReport((r) => ({
                        ...r,
                        severity: e.target.value as any,
                      }))
                    }
                    options={[
                      { value: "low", label: "🟢 Low - Minor inconvenience" },
                      {
                        value: "medium",
                        label: "🟡 Medium - Affects functionality",
                      },
                      {
                        value: "high",
                        label: "🟠 High - Blocks important features",
                      },
                      {
                        value: "critical",
                        label: "🔴 Critical - App unusable",
                      },
                    ]}
                  />

                  <Select
                    label="Component"
                    value={report.component}
                    onChange={(e) =>
                      setReport((r) => ({ ...r, component: e.target.value }))
                    }
                    options={[
                      {
                        value: "knowledge-base",
                        label: "🔍 Knowledge Base / RAG",
                      },
                      { value: "mcp-integration", label: "🔗 MCP Integration" },
                      { value: "projects-tasks", label: "📋 Projects & Tasks" },
                      {
                        value: "settings",
                        label: "⚙️ Settings & Configuration",
                      },
                      { value: "ui", label: "🖥️ User Interface" },
                      {
                        value: "infrastructure",
                        label: "🐳 Docker / Infrastructure",
                      },
                      { value: "not-sure", label: "❓ Not Sure" },
                    ]}
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    What were you trying to do? *
                  </label>
                  <textarea
                    value={report.description}
                    onChange={(e) =>
                      setReport((r) => ({ ...r, description: e.target.value }))
                    }
                    placeholder="I was trying to crawl a documentation site when..."
                    className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    rows={3}
                    required
                  />
                </div>

                {/* Steps to Reproduce */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Steps to Reproduce
                  </label>
                  <textarea
                    value={report.stepsToReproduce}
                    onChange={(e) =>
                      setReport((r) => ({
                        ...r,
                        stepsToReproduce: e.target.value,
                      }))
                    }
                    placeholder="1. Go to Knowledge Base page&#10;2. Click Add Knowledge&#10;3. Enter URL...&#10;4. Error occurs"
                    className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    rows={4}
                  />
                </div>

                {/* Expected vs Actual Behavior */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Expected Behavior
                    </label>
                    <textarea
                      value={report.expectedBehavior}
                      onChange={(e) =>
                        setReport((r) => ({
                          ...r,
                          expectedBehavior: e.target.value,
                        }))
                      }
                      placeholder="What should have happened?"
                      className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                      rows={3}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Actual Behavior
                    </label>
                    <textarea
                      value={report.actualBehavior}
                      onChange={(e) =>
                        setReport((r) => ({
                          ...r,
                          actualBehavior: e.target.value,
                        }))
                      }
                      placeholder="What actually happened?"
                      className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                      rows={3}
                    />
                  </div>
                </div>

                {/* System Info Preview */}
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">
                    System information that will be included
                  </summary>
                  <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-800 rounded text-xs">
                    <div>
                      <strong>Version:</strong> {context.app.version}
                    </div>
                    <div>
                      <strong>Platform:</strong> {context.system.platform}
                    </div>
                    <div>
                      <strong>Memory:</strong> {context.system.memory}
                    </div>
                    <div>
                      <strong>Services:</strong> Server{" "}
                      {context.services.server ? "✅" : "❌"}, MCP{" "}
                      {context.services.mcp ? "✅" : "❌"}, Agents{" "}
                      {context.services.agents ? "✅" : "❌"}
                    </div>
                  </div>
                </details>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-3 justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCopyToClipboard}
                    className="sm:order-1"
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy to Clipboard
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onClose}
                    disabled={submitting}
                    className="sm:order-2"
                  >
                    Cancel
                  </Button>

                  <Button
                    type="submit"
                    disabled={submitting || !report.description.trim()}
                    className="sm:order-3"
                  >
                    {submitting ? (
                      <>
                        <Loader className="w-4 h-4 mr-2 animate-spin" />
                        Creating Issue...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Submit Bug Report
                      </>
                    )}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
