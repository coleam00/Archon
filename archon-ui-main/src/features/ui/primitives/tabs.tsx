import * as TabsPrimitive from "@radix-ui/react-tabs";
import React from "react";
import { cn } from "./styles";

// Root
export const Tabs = TabsPrimitive.Root;

// List - styled like pill navigation
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "backdrop-blur-sm bg-white/40 dark:bg-white/5 border border-white/30 dark:border-white/15",
      "rounded-full p-1 shadow-lg inline-flex gap-1",
      className,
    )}
    role="tablist"
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

// Trigger
type TabColor = "blue" | "purple" | "pink" | "orange" | "cyan" | "green";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
    color?: TabColor;
  }
>(({ className, color = "blue", ...props }, ref) => {
  const activeClasses = {
    blue: [
      "data-[state=active]:bg-blue-500/20 dark:data-[state=active]:bg-blue-400/20",
      "data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-300",
      "data-[state=active]:border data-[state=active]:border-blue-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(59,130,246,0.5)]",
    ].join(" "),
    purple: [
      "data-[state=active]:bg-purple-500/20 dark:data-[state=active]:bg-purple-400/20",
      "data-[state=active]:text-purple-700 dark:data-[state=active]:text-purple-300",
      "data-[state=active]:border data-[state=active]:border-purple-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(168,85,247,0.5)]",
    ].join(" "),
    pink: [
      "data-[state=active]:bg-pink-500/20 dark:data-[state=active]:bg-pink-400/20",
      "data-[state=active]:text-pink-700 dark:data-[state=active]:text-pink-300",
      "data-[state=active]:border data-[state=active]:border-pink-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(236,72,153,0.5)]",
    ].join(" "),
    orange: [
      "data-[state=active]:bg-orange-500/20 dark:data-[state=active]:bg-orange-400/20",
      "data-[state=active]:text-orange-700 dark:data-[state=active]:text-orange-300",
      "data-[state=active]:border data-[state=active]:border-orange-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(251,146,60,0.5)]",
    ].join(" "),
    cyan: [
      "data-[state=active]:bg-cyan-500/20 dark:data-[state=active]:bg-cyan-400/20",
      "data-[state=active]:text-cyan-700 dark:data-[state=active]:text-cyan-300",
      "data-[state=active]:border data-[state=active]:border-cyan-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(34,211,238,0.5)]",
    ].join(" "),
    green: [
      "data-[state=active]:bg-green-500/20 dark:data-[state=active]:bg-green-400/20",
      "data-[state=active]:text-green-700 dark:data-[state=active]:text-green-300",
      "data-[state=active]:border data-[state=active]:border-green-400/50",
      "data-[state=active]:shadow-[0_0_10px_rgba(34,197,94,0.5)]",
    ].join(" "),
  } satisfies Record<TabColor, string>;

  const focusRingClasses = {
    blue: "focus-visible:ring-blue-500",
    purple: "focus-visible:ring-purple-500",
    pink: "focus-visible:ring-pink-500",
    orange: "focus-visible:ring-orange-500",
    cyan: "focus-visible:ring-cyan-500",
    green: "focus-visible:ring-green-500",
  } satisfies Record<TabColor, string>;

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex items-center gap-2 px-4 py-1.5 rounded-full transition-all duration-200",
        "text-xs font-medium whitespace-nowrap",
        "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        focusRingClasses[color],
        "disabled:pointer-events-none disabled:opacity-50",
        activeClasses[color],
        className,
      )}
      {...props}
    >
      {props.children}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

// Content
export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2",
      "focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
