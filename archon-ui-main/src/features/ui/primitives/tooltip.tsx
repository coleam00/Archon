import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import React from "react";
import { cn } from "./styles";

// Provider
export const TooltipProvider = TooltipPrimitive.Provider;

// Root
export const Tooltip = TooltipPrimitive.Root;

// Trigger
export const TooltipTrigger = TooltipPrimitive.Trigger;

// Content with Tron glassmorphism
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md px-3 py-1.5 text-xs",
        // Tron-style glassmorphism with neon glow - dark in both themes
        "backdrop-blur-md",
        "bg-gradient-to-b from-gray-900/95 to-black/95",
        "dark:from-gray-900/95 dark:to-black/95",
        // Neon border with cyan glow
        "border border-cyan-500/50 dark:border-cyan-400/50",
        "shadow-[0_0_15px_rgba(34,211,238,0.5)] dark:shadow-[0_0_15px_rgba(34,211,238,0.7)]",
        // Text colors - cyan in both modes for Tron effect
        "text-cyan-100 dark:text-cyan-100",
        // Subtle inner glow effect
        "before:absolute before:inset-0 before:rounded-md",
        "before:bg-gradient-to-b before:from-cyan-500/10 before:to-transparent",
        "before:pointer-events-none",
        // Animation with more dramatic entrance
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2",
        "data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

// Simple tooltip wrapper for common use case
export interface SimpleTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
}

export const SimpleTooltip: React.FC<SimpleTooltipProps> = ({
  children,
  content,
  side = "top",
  align = "center",
  delayDuration = 200,
}) => {
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
};
