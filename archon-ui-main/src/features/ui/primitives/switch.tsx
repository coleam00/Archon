import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as React from "react";
import { cn, glassmorphism } from "./styles";

export type SwitchSize = "sm" | "md" | "lg";
export type SwitchColor = "purple" | "blue" | "green" | "pink" | "orange" | "cyan";

interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  size?: SwitchSize;
  color?: SwitchColor;
  icon?: React.ReactNode;
  iconOn?: React.ReactNode;
  iconOff?: React.ReactNode;
}

const switchVariants = {
  size: {
    sm: {
      root: "h-4 w-8",
      thumb: "h-3 w-3 data-[state=checked]:translate-x-4",
      icon: "",
    },
    md: {
      root: "h-6 w-11",
      thumb: "h-5 w-5 data-[state=checked]:translate-x-5",
      icon: "h-3 w-3",
    },
    lg: {
      root: "h-8 w-14",
      thumb: "h-7 w-7 data-[state=checked]:translate-x-6",
      icon: "h-5 w-5",
    },
  },
  color: {
    purple: {
      checked: "data-[state=checked]:bg-purple-500/20 data-[state=checked]:border-purple-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(168,85,247,0.5)]",
      thumb: "data-[state=checked]:border-purple-400 data-[state=checked]:shadow-[0_0_10px_rgba(168,85,247,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-purple-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(168,85,247,0.7)]",
      focusRing: "focus-visible:ring-purple-500",
    },
    blue: {
      checked: "data-[state=checked]:bg-blue-500/20 data-[state=checked]:border-blue-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(59,130,246,0.5)]",
      thumb: "data-[state=checked]:border-blue-400 data-[state=checked]:shadow-[0_0_10px_rgba(59,130,246,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-blue-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(59,130,246,0.7)]",
      focusRing: "focus-visible:ring-blue-500",
    },
    green: {
      checked: "data-[state=checked]:bg-green-500/20 data-[state=checked]:border-green-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(34,197,94,0.5)]",
      thumb: "data-[state=checked]:border-green-400 data-[state=checked]:shadow-[0_0_10px_rgba(34,197,94,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-green-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(34,197,94,0.7)]",
      focusRing: "focus-visible:ring-green-500",
    },
    pink: {
      checked: "data-[state=checked]:bg-pink-500/20 data-[state=checked]:border-pink-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(236,72,153,0.5)]",
      thumb: "data-[state=checked]:border-pink-400 data-[state=checked]:shadow-[0_0_10px_rgba(236,72,153,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-pink-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(236,72,153,0.7)]",
      focusRing: "focus-visible:ring-pink-500",
    },
    orange: {
      checked: "data-[state=checked]:bg-orange-500/20 data-[state=checked]:border-orange-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(249,115,22,0.5)]",
      thumb: "data-[state=checked]:border-orange-400 data-[state=checked]:shadow-[0_0_10px_rgba(249,115,22,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-orange-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(249,115,22,0.7)]",
      focusRing: "focus-visible:ring-orange-500",
    },
    cyan: {
      checked: "data-[state=checked]:bg-cyan-500/20 data-[state=checked]:border-cyan-500/50",
      glow: "data-[state=checked]:shadow-[0_0_20px_rgba(34,211,238,0.5)]",
      thumb: "data-[state=checked]:border-cyan-400 data-[state=checked]:shadow-[0_0_10px_rgba(34,211,238,0.5)]",
      icon: "text-gray-500 dark:text-gray-400 data-[state=checked]:text-cyan-400 data-[state=checked]:drop-shadow-[0_0_5px_rgba(34,211,238,0.7)]",
      focusRing: "focus-visible:ring-cyan-500",
    },
  },
};

/**
 * 🤖 AI CONTEXT: Enhanced Switch Component
 *
 * GLASS PROPERTIES for true glassmorphism:
 * 1. TRANSPARENCY - Subtle background opacity
 *    - unchecked: Almost invisible (bg-white/10)
 *    - checked: Color tinted glass (color-500/20)
 *
 * 2. SIZE VARIANTS - Three sizes for different use cases
 *    - sm: 16px height, no icons
 *    - md: 24px height, smaller icons (12x12px)
 *    - lg: 32px height, full icons (20x20px)
 *
 * 3. GLOW EFFECTS - Neon accents that animate
 *    - Box shadow for outer glow
 *    - Drop shadow for icon glow
 *    - Transition animations for smooth state changes
 *
 * 4. ICON SUPPORT - Dynamic icon switching
 *    - iconOn: Displayed when checked
 *    - iconOff: Displayed when unchecked
 *    - icon: Same icon for both states
 *
 * 5. CONTROLLED/UNCONTROLLED MODE SUPPORT
 *    - Controlled: Pass checked prop + onCheckedChange handler
 *    - Uncontrolled: Pass defaultChecked, component manages own state
 */
const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  (
    {
      className,
      size = "md",
      color = "cyan",
      icon,
      iconOn,
      iconOff,
      checked,
      defaultChecked,
      onCheckedChange,
      ...props
    },
    ref,
  ) => {
    const sizeStyles = switchVariants.size[size];
    const colorStyles = switchVariants.color[color];

    // Detect controlled vs uncontrolled mode
    const isControlled = checked !== undefined;

    // Internal state for uncontrolled mode
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked ?? false);

    // Get the actual checked state (controlled or uncontrolled)
    const actualChecked = isControlled ? checked : internalChecked;

    // Handle state changes for both controlled and uncontrolled modes
    const handleCheckedChange = React.useCallback(
      (newChecked: boolean) => {
        // Update internal state for uncontrolled mode
        if (!isControlled) {
          setInternalChecked(newChecked);
        }
        // Call parent's handler if provided
        onCheckedChange?.(newChecked);
      },
      [isControlled, onCheckedChange],
    );

    const displayIcon = React.useMemo(() => {
      if (size === "sm") return null;
      return actualChecked ? iconOn || icon : iconOff || icon;
    }, [size, actualChecked, icon, iconOn, iconOff]);

    return (
      <SwitchPrimitives.Root
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
          "bg-black/10 dark:bg-white/10 backdrop-blur-xl",
          "border border-gray-300/30 dark:border-white/10",
          "transition-all duration-500 ease-in-out",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          colorStyles.focusRing,
          "disabled:cursor-not-allowed disabled:opacity-50",
          colorStyles.checked,
          colorStyles.glow,
          sizeStyles.root,
          glassmorphism.interactive.base,
          className,
        )}
        checked={actualChecked}
        onCheckedChange={handleCheckedChange}
        {...props}
        ref={ref}
      >
        <SwitchPrimitives.Thumb
          className={cn(
            "pointer-events-none relative flex items-center justify-center rounded-full",
            // Glass effect for thumb with proper fill
            "bg-gradient-to-br from-gray-100/80 to-white/60 dark:from-gray-700/80 dark:to-gray-800/60",
            "backdrop-blur-sm border-2",
            "border-gray-400/50 dark:border-white/30",
            "shadow-lg ring-0 transition-all duration-500 cubic-bezier(0.23, 1, 0.32, 1)",
            "data-[state=unchecked]:translate-x-0",
            // Checked state gets color tinted glass
            "data-[state=checked]:from-white/90 data-[state=checked]:to-white/70 dark:data-[state=checked]:from-gray-100/20 dark:data-[state=checked]:to-gray-200/10",
            colorStyles.thumb,
            sizeStyles.thumb,
          )}
        >
          {displayIcon && (
            <div
              className={cn(
                "flex items-center justify-center transition-all duration-500",
                // Icons have color in both states with different opacity
                colorStyles.icon,
                sizeStyles.icon,
              )}
            >
              {displayIcon}
            </div>
          )}
        </SwitchPrimitives.Thumb>
      </SwitchPrimitives.Root>
    );
  },
);

Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch, switchVariants };
