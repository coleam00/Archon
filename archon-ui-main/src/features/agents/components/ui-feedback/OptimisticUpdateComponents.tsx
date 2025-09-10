/**
 * Optimistic Update Components
 *
 * Reusable components for providing visual feedback during optimistic updates
 */

import React from "react";
import { CheckCircle, XCircle, Loader2, AlertCircle } from "lucide-react";
import { cn } from "../../../../lib/utils";

/**
 * Status indicator for optimistic updates
 */
interface OptimisticStatusProps {
  status: "idle" | "optimistic" | "success" | "error";
  className?: string;
  size?: "sm" | "md" | "lg";
}

export const OptimisticStatus: React.FC<OptimisticStatusProps> = ({
  status,
  className,
  size = "md",
}) => {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  const iconClass = sizeClasses[size];

  switch (status) {
    case "optimistic":
      return (
        <Loader2
          className={cn(iconClass, "animate-spin text-blue-500", className)}
        />
      );
    case "success":
      return (
        <CheckCircle className={cn(iconClass, "text-green-500", className)} />
      );
    case "error":
      return <XCircle className={cn(iconClass, "text-red-500", className)} />;
    default:
      return (
        <AlertCircle className={cn(iconClass, "text-gray-400", className)} />
      );
  }
};

/**
 * Wrapper component for optimistic updates with visual feedback
 */
interface OptimisticWrapperProps {
  isOptimistic: boolean;
  hasError: boolean;
  children: React.ReactNode;
  className?: string;
}

export const OptimisticWrapper: React.FC<OptimisticWrapperProps> = ({
  isOptimistic,
  hasError,
  children,
  className,
}) => {
  return (
    <div
      className={cn(
        "transition-all duration-200 ease-in-out",
        {
          "opacity-70 scale-95": isOptimistic,
          "opacity-100 scale-100": !isOptimistic && !hasError,
          "animate-pulse": isOptimistic,
          "border-red-300 bg-red-50": hasError,
        },
        className
      )}
    >
      {children}
    </div>
  );
};

/**
 * Button with optimistic update feedback
 */
interface OptimisticButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  isOptimistic?: boolean;
  hasError?: boolean;
  loadingText?: string;
  optimisticText?: string;
  errorText?: string;
  children: React.ReactNode;
}

export const OptimisticButton: React.FC<OptimisticButtonProps> = ({
  isLoading,
  isOptimistic,
  hasError,
  loadingText,
  optimisticText,
  errorText,
  children,
  className,
  disabled,
  ...props
}) => {
  const getContent = () => {
    if (isLoading) return loadingText || "Loading...";
    if (isOptimistic) return optimisticText || "Updating...";
    if (hasError) return errorText || "Error";
    return children;
  };

  const getIcon = () => {
    if (isLoading || isOptimistic)
      return <Loader2 className="w-4 h-4 animate-spin mr-2" />;
    if (hasError) return <XCircle className="w-4 h-4 mr-2" />;
    return null;
  };

  return (
    <button
      className={cn(
        "inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md transition-all duration-200",
        {
          "bg-blue-600 text-white hover:bg-blue-700":
            !isLoading && !isOptimistic && !hasError,
          "bg-blue-400 text-white cursor-not-allowed":
            isLoading || isOptimistic,
          "bg-red-600 text-white hover:bg-red-700": hasError,
          "opacity-70 scale-95": isOptimistic,
        },
        className
      )}
      disabled={disabled || isLoading || isOptimistic}
      {...props}
    >
      {getIcon()}
      {getContent()}
    </button>
  );
};

/**
 * List item with optimistic add/remove animations
 */
interface OptimisticListItemProps {
  children: React.ReactNode;
  isOptimistic: boolean;
  isRemoving?: boolean;
  className?: string;
}

export const OptimisticListItem: React.FC<OptimisticListItemProps> = ({
  children,
  isOptimistic,
  isRemoving,
  className,
}) => {
  return (
    <div
      className={cn(
        "transition-all duration-300 ease-in-out",
        {
          "opacity-70 scale-95 transform": isOptimistic,
          "opacity-0 scale-90 transform -translate-y-2": isRemoving,
          "opacity-100 scale-100 transform translate-y-0":
            !isOptimistic && !isRemoving,
        },
        className
      )}
    >
      {children}
    </div>
  );
};

/**
 * Toast notification for optimistic updates
 */
interface OptimisticToastProps {
  message: string;
  type: "success" | "error" | "info";
  isOptimistic?: boolean;
}

export const OptimisticToast: React.FC<OptimisticToastProps> = ({
  message,
  type,
  isOptimistic,
}) => {
  const bgColor = {
    success: "bg-green-500",
    error: "bg-red-500",
    info: "bg-blue-500",
  };

  return (
    <div
      className={cn(
        "fixed top-4 right-4 z-50 p-4 rounded-md text-white shadow-lg transition-all duration-300",
        bgColor[type],
        {
          "opacity-70 scale-95": isOptimistic,
          "opacity-100 scale-100": !isOptimistic,
        }
      )}
    >
      <div className="flex items-center">
        <OptimisticStatus
          status={
            isOptimistic
              ? "optimistic"
              : type === "success"
              ? "success"
              : type === "info"
              ? "idle"
              : "error"
          }
        />
        <span className="ml-2">{message}</span>
      </div>
    </div>
  );
};
