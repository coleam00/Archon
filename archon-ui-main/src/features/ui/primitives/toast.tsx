import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle, Info, X, XCircle } from "lucide-react";
import React from "react";
import { cn, glassmorphism } from "./styles";

// Toast Provider - wraps the app
export const ToastProvider = ToastPrimitive.Provider;

// Toast Viewport - where toasts appear
export const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      "fixed top-4 right-4 z-[100]",
      "flex flex-col gap-2",
      "w-full max-w-[420px]",
      "pointer-events-none",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

// Toast Root
export const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & {
    variant?: "default" | "success" | "error" | "warning";
  }
>(({ className, variant = "default", ...props }, ref) => {
  const variantStyles = {
    default: cn(glassmorphism.background.card, glassmorphism.border.default, glassmorphism.shadow.elevated),
    success: cn(
      "backdrop-blur-md bg-gradient-to-b from-green-100/80 dark:from-green-500/20 to-white/60 dark:to-green-500/5",
      "border-green-300 dark:border-green-500/30",
      "shadow-[0_0_10px_2px_rgba(16,185,129,0.4)] dark:shadow-[0_0_20px_5px_rgba(16,185,129,0.7)]",
    ),
    error: cn(
      "backdrop-blur-md bg-gradient-to-b from-red-100/80 dark:from-red-500/20 to-white/60 dark:to-red-500/5",
      "border-red-300 dark:border-red-500/30",
      "shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]",
    ),
    warning: cn(
      "backdrop-blur-md bg-gradient-to-b from-orange-100/80 dark:from-orange-500/20 to-white/60 dark:to-orange-500/5",
      "border-orange-300 dark:border-orange-500/30",
      "shadow-[0_0_10px_2px_rgba(251,146,60,0.4)] dark:shadow-[0_0_20px_5px_rgba(251,146,60,0.7)]",
    ),
  };

  return (
    <ToastPrimitive.Root
      ref={ref}
      className={cn(
        "relative group p-4 rounded-md border",
        "pointer-events-auto",
        "transition-all duration-200",
        glassmorphism.animation.fadeIn,
        "data-[swipe=cancel]:transform-none",
        "data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
        "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
        "data-[state=open]:slide-in-from-right",
        "data-[state=closed]:fade-out-80",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
});
Toast.displayName = ToastPrimitive.Root.displayName;

// Toast Action
export const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Action
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center",
      "rounded-md px-3 py-1 text-sm font-medium",
      "bg-cyan-500/20 dark:bg-cyan-400/20",
      "border border-cyan-300 dark:border-cyan-500/30",
      "text-cyan-700 dark:text-cyan-300",
      "hover:bg-cyan-500/30 dark:hover:bg-cyan-400/30",
      glassmorphism.interactive.base,
      glassmorphism.interactive.disabled,
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitive.Action.displayName;

// Toast Close
export const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      "absolute top-2 right-2",
      "text-gray-500 dark:text-gray-400",
      "hover:text-gray-700 dark:hover:text-white",
      "transition-colors",
      "opacity-0 group-hover:opacity-100",
      "focus:opacity-100 focus:outline-none",
      className,
    )}
    {...props}
  >
    <X className="h-4 w-4" />
    <span className="sr-only">Close</span>
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

// Toast Title
export const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title
    ref={ref}
    className={cn("text-sm font-semibold text-gray-900 dark:text-white", className)}
    {...props}
  />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

// Toast Description
export const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn("mt-1 text-sm text-gray-600 dark:text-gray-400", className)}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

// Helper function to get icon for toast type
export function getToastIcon(type: "success" | "error" | "info" | "warning") {
  switch (type) {
    case "success":
      return <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />;
    case "error":
      return <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />;
    case "info":
      return <Info className="h-5 w-5 text-blue-600 dark:text-blue-400" />;
    case "warning":
      return <AlertCircle className="h-5 w-5 text-orange-600 dark:text-orange-400" />;
  }
}
