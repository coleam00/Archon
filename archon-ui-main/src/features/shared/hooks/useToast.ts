import { AlertCircle, CheckCircle, Info, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createOptimisticId } from "../optimistic";

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
  removeToast: (id: string) => void;
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
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const showToast = useCallback((message: string, type: Toast["type"] = "info", duration = 4000) => {
    const id = createOptimisticId();
    const newToast: Toast = { id, message, type, duration };

    setToasts((prev) => [...prev, newToast]);

    // Auto-dismiss after duration
    if (duration > 0) {
      const timeoutId = setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
        timeoutsRef.current.delete(id);
      }, duration);
      timeoutsRef.current.set(id, timeoutId);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    const timeoutId = timeoutsRef.current.get(id);
    if (timeoutId != null) {
      clearTimeout(timeoutId);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      for (const timeoutId of timeoutsRef.current.values()) clearTimeout(timeoutId);
      timeoutsRef.current.clear();
    };
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
