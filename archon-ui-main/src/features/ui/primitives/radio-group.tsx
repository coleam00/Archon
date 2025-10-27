import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import React from "react";
import { cn, glassmorphism } from "./styles";

export const RadioGroup = RadioGroupPrimitive.Root;

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "aspect-square h-4 w-4 rounded-full",
      "backdrop-blur-md bg-gradient-to-b from-white/80 to-white/60",
      "dark:from-white/10 dark:to-black/30",
      glassmorphism.border.default,
      glassmorphism.interactive.base,
      "focus:outline-none focus:ring-2 focus:ring-cyan-500",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-cyan-500",
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <Circle className="h-2.5 w-2.5 fill-cyan-500 text-cyan-500" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;
