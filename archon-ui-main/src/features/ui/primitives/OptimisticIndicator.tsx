import { Loader2 } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "./styles";

interface OptimisticIndicatorProps {
  isOptimistic: boolean;
  className?: string;
  showSpinner?: boolean;
  pulseAnimation?: boolean;
}

/**
 * Visual indicator for optimistic updates
 * Shows a subtle animation and optional spinner for pending items
 */
export function OptimisticIndicator({
  isOptimistic,
  className,
  showSpinner = true,
  pulseAnimation = true,
}: OptimisticIndicatorProps) {
  if (!isOptimistic) return null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {showSpinner && <Loader2 className="h-3 w-3 animate-spin text-cyan-400/70" />}
      {pulseAnimation && <span className="text-xs text-cyan-400/50 animate-pulse">Saving...</span>}
    </div>
  );
}

/**
 * HOC to wrap components with optimistic styling
 */
export function withOptimisticStyles<T extends { className?: string }>(
  Component: ComponentType<T>,
  isOptimistic: boolean,
) {
  return (props: T) => (
    <Component
      {...props}
      className={cn(props.className, isOptimistic && "opacity-70 animate-pulse ring-1 ring-cyan-400/20")}
    />
  );
}
