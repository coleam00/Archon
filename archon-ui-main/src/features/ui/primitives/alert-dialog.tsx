import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import React from "react";
import { cn, glassmorphism } from "./styles";

// Root
export const AlertDialog = AlertDialogPrimitive.Root;

// Trigger
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

// Portal
const AlertDialogPortal = AlertDialogPrimitive.Portal;

// Overlay with backdrop blur
const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50",
      "bg-black/50 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

// Content with Tron glassmorphism
export const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> & {
    variant?: "default" | "destructive";
  }
>(({ className, variant = "default", ...props }, ref) => {
  const variantStyles = {
    default: cn(
      "before:bg-gradient-to-r before:from-cyan-500 before:to-fuchsia-500",
      "before:shadow-[0_0_10px_2px_rgba(34,211,238,0.4)]",
      "dark:before:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]",
    ),
    destructive: cn(
      "before:bg-red-500",
      "before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)]",
      "dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]",
    ),
  };

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "p-6 rounded-md backdrop-blur-md",
          "w-full max-w-lg",
          glassmorphism.background.card,
          glassmorphism.border.default,
          glassmorphism.shadow.elevated,
          // Top gradient bar
          "before:content-[''] before:absolute before:top-0 before:left-0 before:right-0",
          "before:h-[2px] before:rounded-t-[4px]",
          variantStyles[variant],
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
});
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

// Header
export const AlertDialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
  ),
);
AlertDialogHeader.displayName = "AlertDialogHeader";

// Footer
export const AlertDialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  ),
);
AlertDialogFooter.displayName = "AlertDialogFooter";

// Title
export const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold", "text-gray-900 dark:text-gray-100", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

// Description
export const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-gray-600 dark:text-gray-400", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

// Action (main CTA button)
export const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => <AlertDialogPrimitive.Action ref={ref} className={className} {...props} />);
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

// Cancel button
export const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => <AlertDialogPrimitive.Cancel ref={ref} className={className} {...props} />);
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;
