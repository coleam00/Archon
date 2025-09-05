import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useState } from "react";

// Toast types
interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
  duration?: number;
}

// Toast context type
interface ToastContextType {
  showToast: (message: string, type?: Toast["type"], duration?: number) => void;
}

// Create context
const ToastContext = createContext<ToastContextType | undefined>(undefined);

/**
 * Hook to show toast notifications
 * Provides the same API as legacy ToastContext for easy migration
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

/**
 * Create toast context value with state management
 * Used internally by ToastProvider component
 */
export function createToastContext() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: Toast["type"] = "info", duration = 4000) => {
    const id = Date.now().toString();
    const newToast: Toast = { id, message, type, duration };

    setToasts((prev) => [...prev, newToast]);

    // Auto-dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return {
    toasts,
    showToast,
    removeToast,
  };
}

// Export context for provider
export { ToastContext };

// Export toast type for external use
export type { Toast, ToastContextType };

// Helper to get icon for toast type
export function getToastIcon(type: Toast["type"]) {
  switch (type) {
    case "success":
      return CheckCircle;
    case "error":
      return XCircle;
    case "info":
      return Info;
    case "warning":
      return AlertCircle;
  }
}
