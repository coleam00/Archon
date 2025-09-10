import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import React from "react";
import { cn } from "./styles";

// Select Root - just re-export
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

// Select Trigger with glassmorphism styling
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    showChevron?: boolean;
  }
>(({ className = "", children, showChevron = true, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex items-center justify-between gap-2 px-3 py-2 rounded-lg",
      "backdrop-blur-md bg-gradient-to-b from-white/80 to-white/60",
      "dark:from-white/10 dark:to-black/30",
      "border border-gray-200 dark:border-gray-700",
      "transition-all duration-200",
      "hover:border-cyan-400/50 hover:shadow-[0_0_10px_rgba(34,211,238,0.2)]",
      "focus:outline-none focus:border-cyan-500 focus:shadow-[0_0_15px_rgba(34,211,238,0.3)]",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      "data-[placeholder]:text-gray-500 dark:data-[placeholder]:text-gray-400",
      className,
    )}
    {...props}
  >
    {children}
    {showChevron && (
      <SelectPrimitive.Icon className="ml-auto">
        <ChevronDown className="w-3 h-3 opacity-60" />
      </SelectPrimitive.Icon>
    )}
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

// Select Content with glassmorphism and Portal for z-index solution
export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className = "", children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-[10000] min-w-[8rem] overflow-hidden rounded-lg",
        // Matching our card glassmorphism
        "backdrop-blur-md bg-gradient-to-b from-white/80 to-white/60",
        "dark:from-white/10 dark:to-black/30",
        "border border-gray-200 dark:border-zinc-800/50",
        // Tron shadow with subtle cyan glow
        "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
        "shadow-cyan-500/5 dark:shadow-cyan-500/10",
        // Text colors matching rest of app
        "text-gray-900 dark:text-gray-100",
        // Animation
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2",
        "data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      position={position}
      sideOffset={5}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

// Select Item with hover effects
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    icon?: React.ReactNode;
  }
>(({ className = "", children, icon, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex items-center text-sm outline-none",
      "transition-all duration-150 cursor-pointer rounded-md",
      "pl-8 pr-3 py-2", // Added left padding for checkmark space
      // Text colors
      "text-gray-700 dark:text-gray-200",
      // Hover state with subtle cyan tint
      "hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20",
      "hover:text-gray-900 dark:hover:text-white",
      // Focus state
      "focus:bg-cyan-500/20 dark:focus:bg-cyan-400/20",
      "focus:text-gray-900 dark:focus:text-white",
      // Disabled state
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      // Selected/checked state with stronger cyan
      "data-[state=checked]:bg-cyan-500/30 dark:data-[state=checked]:bg-cyan-400/30",
      "data-[state=checked]:text-cyan-700 dark:data-[state=checked]:text-cyan-300",
      "data-[state=checked]:font-medium",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemIndicator className="absolute left-2 flex h-4 w-4 items-center justify-center">
      <Check className="h-4 w-4" />
    </SelectPrimitive.ItemIndicator>
    <SelectPrimitive.ItemText className="flex items-center gap-2">
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children}
    </SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

// Export group and label for completeness
export const SelectGroup = SelectPrimitive.Group;
export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className = "", ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={`px-2 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-400 ${className}`}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;
