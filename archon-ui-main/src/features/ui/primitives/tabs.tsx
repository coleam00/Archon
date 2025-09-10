import * as TabsPrimitive from "@radix-ui/react-tabs";
import React from "react";
import { cn } from "./styles";

// Root
export const Tabs = TabsPrimitive.Root;

// List
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("relative", className)} role="tablist" {...props}>
    {/* Subtle neon glow effect */}
    <div className="absolute inset-0 rounded-lg opacity-30 blur-[1px] bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-pink-500/10 pointer-events-none" />
    {props.children}
  </TabsPrimitive.List>
));
TabsList.displayName = TabsPrimitive.List.displayName;

// Trigger
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
    color?: "blue" | "purple" | "pink" | "orange" | "cyan" | "green";
  }
>(({ className, color = "blue", ...props }, ref) => {
  const colorMap = {
    blue: {
      text: "data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400",
      glow: "data-[state=active]:bg-blue-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]",
      hover: "hover:text-blue-500 dark:hover:text-blue-400/70",
    },
    purple: {
      text: "data-[state=active]:text-purple-600 dark:data-[state=active]:text-purple-400",
      glow: "data-[state=active]:bg-purple-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]",
      hover: "hover:text-purple-500 dark:hover:text-purple-400/70",
    },
    pink: {
      text: "data-[state=active]:text-pink-600 dark:data-[state=active]:text-pink-400",
      glow: "data-[state=active]:bg-pink-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(236,72,153,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(236,72,153,0.7)]",
      hover: "hover:text-pink-500 dark:hover:text-pink-400/70",
    },
    orange: {
      text: "data-[state=active]:text-orange-600 dark:data-[state=active]:text-orange-400",
      glow: "data-[state=active]:bg-orange-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(249,115,22,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(249,115,22,0.7)]",
      hover: "hover:text-orange-500 dark:hover:text-orange-400/70",
    },
    cyan: {
      text: "data-[state=active]:text-cyan-600 dark:data-[state=active]:text-cyan-400",
      glow: "data-[state=active]:bg-cyan-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(34,211,238,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]",
      hover: "hover:text-cyan-500 dark:hover:text-cyan-400/70",
    },
    green: {
      text: "data-[state=active]:text-emerald-600 dark:data-[state=active]:text-emerald-400",
      glow: "data-[state=active]:bg-emerald-500 data-[state=active]:shadow-[0_0_10px_2px_rgba(16,185,129,0.4)] dark:data-[state=active]:shadow-[0_0_20px_5px_rgba(16,185,129,0.7)]",
      hover: "hover:text-emerald-500 dark:hover:text-emerald-400/70",
    },
  };

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative px-24 py-10 font-mono transition-all duration-300 z-10",
        "text-gray-600 dark:text-gray-400",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        colorMap[color].text,
        colorMap[color].hover,
        className,
      )}
      {...props}
    >
      {props.children}
      {/* Active state neon indicator - only show when active */}
      <span
        className={cn(
          "absolute bottom-0 left-0 right-0 w-full h-[2px]",
          "data-[state=active]:block hidden",
          colorMap[color].glow,
        )}
      />
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
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
