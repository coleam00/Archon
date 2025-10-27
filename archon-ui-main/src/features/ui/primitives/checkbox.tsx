import * as CheckboxPrimitives from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import * as React from "react";
import { cn, glassmorphism } from "./styles";

export type CheckboxColor = "purple" | "blue" | "green" | "pink" | "orange" | "cyan";

interface CheckboxProps extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitives.Root> {
  color?: CheckboxColor;
  indeterminate?: boolean;
}

const checkboxVariants = {
  purple: {
    checked: "data-[state=checked]:bg-purple-500/20 data-[state=checked]:border-purple-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(168,85,247,0.5)]",
    indicator: "text-purple-400 drop-shadow-[0_0_3px_rgba(168,85,247,0.7)]",
    focusRing: "focus-visible:ring-purple-500",
  },
  blue: {
    checked: "data-[state=checked]:bg-blue-500/20 data-[state=checked]:border-blue-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(59,130,246,0.5)]",
    indicator: "text-blue-400 drop-shadow-[0_0_3px_rgba(59,130,246,0.7)]",
    focusRing: "focus-visible:ring-blue-500",
  },
  green: {
    checked: "data-[state=checked]:bg-green-500/20 data-[state=checked]:border-green-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(34,197,94,0.5)]",
    indicator: "text-green-400 drop-shadow-[0_0_3px_rgba(34,197,94,0.7)]",
    focusRing: "focus-visible:ring-green-500",
  },
  pink: {
    checked: "data-[state=checked]:bg-pink-500/20 data-[state=checked]:border-pink-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(236,72,153,0.5)]",
    indicator: "text-pink-400 drop-shadow-[0_0_3px_rgba(236,72,153,0.7)]",
    focusRing: "focus-visible:ring-pink-500",
  },
  orange: {
    checked: "data-[state=checked]:bg-orange-500/20 data-[state=checked]:border-orange-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(249,115,22,0.5)]",
    indicator: "text-orange-400 drop-shadow-[0_0_3px_rgba(249,115,22,0.7)]",
    focusRing: "focus-visible:ring-orange-500",
  },
  cyan: {
    checked: "data-[state=checked]:bg-cyan-500/20 data-[state=checked]:border-cyan-500",
    glow: "data-[state=checked]:shadow-[0_0_15px_rgba(34,211,238,0.5)]",
    indicator: "text-cyan-400 drop-shadow-[0_0_3px_rgba(34,211,238,0.7)]",
    focusRing: "focus-visible:ring-cyan-500",
  },
};

/**
 * 🤖 AI CONTEXT: Glassmorphic Checkbox Component
 *
 * DESIGN DECISIONS:
 * 1. TRANSPARENCY - Glass effect with subtle background
 *    - Unchecked: Almost invisible (bg-white/10)
 *    - Checked: Color tinted glass (color-500/20)
 *
 * 2. NEON GLOW - Tron-style accent on activation
 *    - Box shadow creates outer glow
 *    - Drop shadow on check icon for depth
 *
 * 3. ANIMATION - Smooth state transitions
 *    - Scale animation on check/uncheck
 *    - Fade in/out for indicator
 *    - 300ms transitions for smoothness
 *
 * 4. STATES - Support for three states
 *    - Unchecked: Empty box
 *    - Checked: Check icon with glow
 *    - Indeterminate: Minus icon (partial selection)
 */
const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitives.Root>, CheckboxProps>(
  ({ className, color = "cyan", indeterminate, checked, ...props }, ref) => {
    const colorStyles = checkboxVariants[color];

    return (
      <CheckboxPrimitives.Root
        className={cn(
          "peer h-5 w-5 shrink-0 rounded-md",
          "bg-black/10 dark:bg-white/10 backdrop-blur-xl",
          "border-2 border-gray-300/30 dark:border-white/10",
          "transition-all duration-300",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          colorStyles.focusRing,
          "disabled:cursor-not-allowed disabled:opacity-50",
          "hover:border-gray-400/50 dark:hover:border-white/20",
          colorStyles.checked,
          colorStyles.glow,
          "data-[state=indeterminate]:bg-opacity-50",
          glassmorphism.interactive.base,
          className,
        )}
        checked={indeterminate ? "indeterminate" : checked}
        {...props}
        ref={ref}
      >
        <CheckboxPrimitives.Indicator
          className={cn(
            "flex items-center justify-center",
            "data-[state=checked]:animate-in data-[state=checked]:zoom-in-0",
            "data-[state=unchecked]:animate-out data-[state=unchecked]:zoom-out-0",
            "data-[state=indeterminate]:animate-in data-[state=indeterminate]:zoom-in-0",
          )}
        >
          {indeterminate ? (
            <Minus className={cn("h-3.5 w-3.5", colorStyles.indicator)} />
          ) : (
            <Check className={cn("h-4 w-4", colorStyles.indicator)} />
          )}
        </CheckboxPrimitives.Indicator>
      </CheckboxPrimitives.Root>
    );
  },
);

Checkbox.displayName = CheckboxPrimitives.Root.displayName;

export { Checkbox, checkboxVariants };
