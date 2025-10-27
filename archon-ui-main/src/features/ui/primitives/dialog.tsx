import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import React from "react";
import { cn } from "./styles";

// Dialog Root and Trigger
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

// Dialog Overlay with glassmorphism
export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50",
      "backdrop-blur-sm bg-black/50 dark:bg-black/70",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// Dialog Content with Tron-style glassmorphism
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
  }
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        "p-6 rounded-md backdrop-blur-md",
        "w-full max-w-2xl",
        // Matching original glassmorphism
        "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30",
        "border border-gray-200 dark:border-zinc-800/50",
        "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
        // Top gradient bar (matching original)
        "before:content-[''] before:absolute before:top-0 before:left-0 before:right-0",
        "before:h-[2px] before:rounded-t-[4px]",
        "before:bg-gradient-to-r before:from-cyan-500 before:to-fuchsia-500",
        "before:shadow-[0_0_10px_2px_rgba(34,211,238,0.4)]",
        "dark:before:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]",
        // Top gradient glow (matching original)
        "after:content-[''] after:absolute after:top-0 after:left-0 after:right-0",
        "after:h-16 after:bg-gradient-to-b",
        "after:from-cyan-100 after:to-white dark:after:from-cyan-500/20 dark:after:to-fuchsia-500/5",
        "after:rounded-t-md after:pointer-events-none",
        className,
      )}
      {...props}
    >
      <div className="relative z-10">{children}</div>
      {showCloseButton && (
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4 z-20",
            "text-gray-500 dark:text-gray-400",
            "hover:text-gray-700 dark:hover:text-white",
            "transition-colors",
          )}
        >
          <X className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

// Dialog Header
export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 text-center sm:text-left", "mb-4", className)} {...props} />
  ),
);
DialogHeader.displayName = "DialogHeader";

// Dialog Footer
export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", "mt-6", className)}
      {...props}
    />
  ),
);
DialogFooter.displayName = "DialogFooter";

// Dialog Title
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-xl font-bold",
      "bg-gradient-to-r from-cyan-400 to-fuchsia-500",
      "text-transparent bg-clip-text",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

// Dialog Description
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-gray-600 dark:text-gray-400", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
