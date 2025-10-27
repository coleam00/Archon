import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import React from "react";
import { cn, glassmorphism } from "./styles";

export type SelectColor = "purple" | "blue" | "green" | "pink" | "orange" | "cyan";

// Select Root - just re-export
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

const selectColorVariants = {
  purple: {
    trigger:
      "hover:border-purple-400/50 hover:shadow-[0_0_15px_rgba(168,85,247,0.3)] focus:border-purple-500 focus:shadow-[0_0_20px_rgba(168,85,247,0.4)]",
    item: "hover:bg-purple-500/20 dark:hover:bg-purple-400/20 data-[state=checked]:bg-purple-500/30 dark:data-[state=checked]:bg-purple-400/30 data-[state=checked]:text-purple-700 dark:data-[state=checked]:text-purple-300",
  },
  blue: {
    trigger:
      "hover:border-blue-400/50 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] focus:border-blue-500 focus:shadow-[0_0_20px_rgba(59,130,246,0.4)]",
    item: "hover:bg-blue-500/20 dark:hover:bg-blue-400/20 data-[state=checked]:bg-blue-500/30 dark:data-[state=checked]:bg-blue-400/30 data-[state=checked]:text-blue-700 dark:data-[state=checked]:text-blue-300",
  },
  green: {
    trigger:
      "hover:border-green-400/50 hover:shadow-[0_0_15px_rgba(34,197,94,0.3)] focus:border-green-500 focus:shadow-[0_0_20px_rgba(34,197,94,0.4)]",
    item: "hover:bg-green-500/20 dark:hover:bg-green-400/20 data-[state=checked]:bg-green-500/30 dark:data-[state=checked]:bg-green-400/30 data-[state=checked]:text-green-700 dark:data-[state=checked]:text-green-300",
  },
  pink: {
    trigger:
      "hover:border-pink-400/50 hover:shadow-[0_0_15px_rgba(236,72,153,0.3)] focus:border-pink-500 focus:shadow-[0_0_20px_rgba(236,72,153,0.4)]",
    item: "hover:bg-pink-500/20 dark:hover:bg-pink-400/20 data-[state=checked]:bg-pink-500/30 dark:data-[state=checked]:bg-pink-400/30 data-[state=checked]:text-pink-700 dark:data-[state=checked]:text-pink-300",
  },
  orange: {
    trigger:
      "hover:border-orange-400/50 hover:shadow-[0_0_15px_rgba(249,115,22,0.3)] focus:border-orange-500 focus:shadow-[0_0_20px_rgba(249,115,22,0.4)]",
    item: "hover:bg-orange-500/20 dark:hover:bg-orange-400/20 data-[state=checked]:bg-orange-500/30 dark:data-[state=checked]:bg-orange-400/30 data-[state=checked]:text-orange-700 dark:data-[state=checked]:text-orange-300",
  },
  cyan: {
    trigger:
      "hover:border-cyan-400/50 hover:shadow-[0_0_15px_rgba(34,211,238,0.3)] focus:border-cyan-500 focus:shadow-[0_0_20px_rgba(34,211,238,0.4)]",
    item: "hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20 data-[state=checked]:bg-cyan-500/30 dark:data-[state=checked]:bg-cyan-400/30 data-[state=checked]:text-cyan-700 dark:data-[state=checked]:text-cyan-300",
  },
};

/**
 * 🤖 AI CONTEXT: Enhanced Select Trigger
 *
 * GLASSMORPHISM ENHANCEMENTS:
 * 1. TRANSPARENCY - True glass effect with backdrop blur
 * 2. NEON BORDERS - Color-coded focus states
 * 3. GLOW EFFECTS - Box shadows for depth
 * 4. COLOR VARIANTS - Support for theme colors
 */
// Select Trigger with glassmorphism styling
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    showChevron?: boolean;
    color?: SelectColor;
  }
>(({ className = "", children, showChevron = true, color = "cyan", ...props }, ref) => {
  const colorStyles = selectColorVariants[color];

  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-2 px-3 py-2 rounded-lg",
        "backdrop-blur-xl bg-black/10 dark:bg-white/10",
        "border border-gray-300/30 dark:border-white/10",
        "transition-all duration-300",
        colorStyles.trigger,
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "data-[placeholder]:text-gray-500 dark:data-[placeholder]:text-gray-400",
        glassmorphism.interactive.base,
        className,
      )}
      {...props}
    >
      {children}
      {showChevron && (
        <SelectPrimitive.Icon className="ml-auto">
          <ChevronDown className="w-3 h-3 opacity-60 transition-transform duration-300 data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      )}
    </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/**
 * 🤖 AI CONTEXT: Enhanced Select Content
 *
 * GLASS DROPDOWN DESIGN:
 * 1. TRANSPARENCY - Full glass effect on dropdown
 * 2. BACKDROP BLUR - Heavy blur for content behind
 * 3. NEON GLOW - Subtle color-matched glow
 * 4. PORTAL - Ensures z-index above all content
 */
// Select Content with glassmorphism and Portal for z-index solution
export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    color?: SelectColor;
  }
>(({ className = "", children, position = "popper", color = "cyan", ...props }, ref) => {
  const glowColor = {
    purple: "shadow-purple-500/20 dark:shadow-purple-500/30",
    blue: "shadow-blue-500/20 dark:shadow-blue-500/30",
    green: "shadow-green-500/20 dark:shadow-green-500/30",
    pink: "shadow-pink-500/20 dark:shadow-pink-500/30",
    orange: "shadow-orange-500/20 dark:shadow-orange-500/30",
    cyan: "shadow-cyan-500/20 dark:shadow-cyan-500/30",
  }[color];

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          "relative z-[10000] min-w-[8rem] overflow-hidden rounded-lg",
          // True glassmorphism
          "backdrop-blur-xl bg-black/20 dark:bg-white/10",
          "border border-gray-300/30 dark:border-white/10",
          // Neon shadow with color glow
          "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.3)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
          glowColor,
          // Text colors
          "text-gray-900 dark:text-gray-100",
          // Animation
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2",
          "data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2",
          "data-[side=top]:slide-in-from-bottom-2",
          glassmorphism.animation.fadeIn,
          className,
        )}
        position={position}
        sideOffset={5}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

// Select Item with hover effects
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    icon?: React.ReactNode;
    color?: SelectColor;
  }
>(({ className = "", children, icon, color = "cyan", ...props }, ref) => {
  const colorStyles = selectColorVariants[color];

  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex items-center text-sm outline-none",
        "transition-all duration-150 cursor-pointer rounded-md",
        "pl-8 pr-3 py-2", // Added left padding for checkmark space
        // Text colors
        "text-gray-700 dark:text-gray-200",
        // Hover and focus states with color tint
        "hover:text-gray-900 dark:hover:text-white",
        "focus:text-gray-900 dark:focus:text-white",
        // Disabled state
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        // Selected/checked state with stronger color
        "data-[state=checked]:font-medium",
        colorStyles.item,
        glassmorphism.interactive.base,
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
  );
});
SelectItem.displayName = SelectPrimitive.Item.displayName;

// Export group and label for completeness
export const SelectGroup = SelectPrimitive.Group;
export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className = "", ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-400", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;
