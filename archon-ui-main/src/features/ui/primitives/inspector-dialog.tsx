/**
 * Inspector Dialog - Large fullscreen scrollable dialog primitive
 * Built on Radix Dialog but optimized for complex scrollable layouts
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { X } from "lucide-react";
import React from "react";
import { cn } from "./styles";

// Re-export Radix primitives
export const InspectorDialog = DialogPrimitive.Root;
export const InspectorDialogTrigger = DialogPrimitive.Trigger;
export const InspectorDialogPortal = DialogPrimitive.Portal;
export const InspectorDialogClose = DialogPrimitive.Close;

// Specialized overlay for large modals
export const InspectorDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50",
      "backdrop-blur-sm bg-black/60 dark:bg-black/80",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
InspectorDialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// Specialized content for large scrollable modals - NO wrapper div
export const InspectorDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
  }
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <InspectorDialogPortal>
    <InspectorDialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Positioning
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        // Size - large modal
        "w-full max-w-7xl h-[85vh]",
        // Tron-style glassmorphism
        "backdrop-blur-md rounded-xl border",
        "bg-gradient-to-b from-black/40 to-black/60",
        "border-cyan-500/20",
        "shadow-[0_0_50px_-12px_rgba(6,182,212,0.25)]",
        // Top accent line
        "before:content-[''] before:absolute before:top-0 before:left-0 before:right-0",
        "before:h-[2px] before:rounded-t-xl",
        "before:bg-gradient-to-r before:from-cyan-500 before:to-fuchsia-500",
        "before:shadow-[0_0_20px_rgba(6,182,212,0.6)]",
        // Ensure this is a flex container for layouts
        "flex flex-col",
        // No padding - let children handle their own spacing
        "p-0 overflow-hidden",
        className,
      )}
      {...props}
    >
      {/* NO wrapper div - direct children for proper flex layout */}
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4 z-50",
            "text-gray-400 hover:text-white",
            "bg-black/20 hover:bg-black/40",
            "border border-white/10 hover:border-cyan-500/30",
            "rounded-lg p-2 transition-all",
            "backdrop-blur-sm",
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </InspectorDialogPortal>
));
InspectorDialogContent.displayName = "InspectorDialogContent";

// Specialized title for large modals (visually hidden since we have custom headers)
export const InspectorDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, children, ...props }, ref) => (
  <VisuallyHidden asChild>
    <DialogPrimitive.Title ref={ref} className={className} {...props}>
      {children}
    </DialogPrimitive.Title>
  </VisuallyHidden>
));
InspectorDialogTitle.displayName = DialogPrimitive.Title.displayName;
