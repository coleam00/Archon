import { useState } from "react";
import { bugReportService, BugContext } from "../services/bugReportService";

export const useBugReport = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState<BugContext | null>(null);
  const [loading, setLoading] = useState(false);

  const openBugReport = async (error?: Error) => {
    setLoading(true);

    try {
      const bugContext = await bugReportService.collectBugContext(error);
      setContext(bugContext);
      setIsOpen(true);
    } catch (contextError) {
      console.error("Failed to collect bug context:", contextError);
      // Still open the modal but with minimal context
      setContext({
        error: {
          message: error?.message || "Manual bug report",
          stack: error?.stack,
          name: error?.name || "Bug Report",
        },
        app: {
          version: "unknown",
          url: window.location.href,
          timestamp: new Date().toISOString(),
        },
        system: {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          memory: "unknown",
        },
        services: {
          server: false,
          mcp: false,
          agents: false,
        },
        logs: ["Failed to collect logs"],
      });
      setIsOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const closeBugReport = () => {
    setIsOpen(false);
    setContext(null);
  };

  return {
    isOpen,
    context,
    loading,
    openBugReport,
    closeBugReport,
  };
};
