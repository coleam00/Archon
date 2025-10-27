import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import React from "react";
import { cn, glassmorphism } from "./styles";

type ToggleGroupProps = (
  | ToggleGroupPrimitive.ToggleGroupSingleProps
  | ToggleGroupPrimitive.ToggleGroupMultipleProps
) & {
  variant?: "subtle" | "solid";
  size?: "sm" | "md";
  className?: string;
};

export const ToggleGroup = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Root>, ToggleGroupProps>(
  ({ className, variant = "subtle", size = "sm", ...props }, ref) => {
    return (
      <ToggleGroupPrimitive.Root
        ref={ref}
        className={cn(
          "inline-flex items-center rounded-lg overflow-hidden",
          variant === "subtle" &&
            cn(glassmorphism.background.subtle, glassmorphism.border.default, glassmorphism.shadow.elevated),
          variant === "solid" && cn(glassmorphism.background.cyan, glassmorphism.border.cyan, glassmorphism.shadow.lg),
          className,
        )}
        {...props}
      />
    );
  },
);
ToggleGroup.displayName = "ToggleGroup";

export interface ToggleGroupItemProps extends React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> {
  size?: "sm" | "md";
}

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  ToggleGroupItemProps
>(({ className, size = "sm", ...props }, ref) => {
  const sizes = {
    sm: "px-3 py-2 text-xs",
    md: "px-4 py-2.5 text-sm",
  } as const;

  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        "relative select-none outline-none transition-all",
        sizes[size],
        "text-gray-600 dark:text-gray-300 hover:text-white",
        "data-[state=on]:text-cyan-700 dark:data-[state=on]:text-cyan-300",
        "data-[state=on]:bg-cyan-500/20",
        "focus-visible:ring-2 focus-visible:ring-cyan-500/50",
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = "ToggleGroupItem";
