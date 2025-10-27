import type React from "react";
import { createToastContext, getToastIcon, ToastContext } from "../../shared/hooks/useToast";
import {
  ToastProvider as RadixToastProvider,
  Toast,
  ToastClose,
  ToastDescription,
  ToastViewport,
} from "../primitives/toast";

interface ToastProviderProps {
  children: React.ReactNode;
  duration?: number;
  swipeDirection?: "right" | "left" | "up" | "down";
}

/**
 * Toast Provider Component
 * Wraps the app with Radix ToastProvider and manages toast state
 * Provides the same API as legacy ToastContext for easy migration
 */
export function ToastProvider({ children, duration = 4000, swipeDirection = "right" }: ToastProviderProps) {
  const { toasts, showToast, removeToast } = createToastContext();

  return (
    <RadixToastProvider duration={duration} swipeDirection={swipeDirection}>
      <ToastContext.Provider value={{ showToast, removeToast }}>
        {children}
        {toasts.map((toast) => {
          const Icon = getToastIcon(toast.type);
          const variantMap = {
            success: "success" as const,
            error: "error" as const,
            warning: "warning" as const,
            info: "default" as const,
          };

          return (
            <Toast key={toast.id} variant={variantMap[toast.type]} duration={toast.duration || duration}>
              <div className="flex items-start gap-3">
                {Icon && <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />}
                <div className="flex-1">
                  <ToastDescription>{toast.message}</ToastDescription>
                </div>
              </div>
              <ToastClose onClick={() => removeToast(toast.id)} />
            </Toast>
          );
        })}
      </ToastContext.Provider>
      <ToastViewport />
    </RadixToastProvider>
  );
}
