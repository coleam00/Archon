import React from "react";
import { cn, glassCard } from "./styles";

interface DataCardProps extends React.HTMLAttributes<HTMLDivElement> {
  // Edge-lit properties
  edgePosition?: "none" | "top" | "left" | "right" | "bottom";
  edgeColor?: "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";

  // Glow properties
  glowColor?: "none" | "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";

  // Glass properties
  blur?: "none" | "sm" | "md" | "lg" | "xl";
  transparency?: "clear" | "light" | "medium" | "frosted" | "solid";
}

interface DataCardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}
interface DataCardContentProps extends React.HTMLAttributes<HTMLDivElement> {}
interface DataCardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DataCard = React.forwardRef<HTMLDivElement, DataCardProps>(
  (
    {
      className,
      edgePosition = "none",
      edgeColor = "cyan",
      glowColor = "none",
      blur = "md",
      transparency = "light",
      children,
      ...props
    },
    ref,
  ) => {
    const hasEdge = edgePosition !== "none";
    const hasGlow = glowColor !== "none";
    const glowVariant = glowColor !== "none" ? glassCard.variants[glowColor] : glassCard.variants.none;

    if (hasEdge && edgePosition === "top") {
      return (
        <div
          ref={ref}
          className={cn(
            glassCard.base,
            glassCard.edgeColors[edgeColor].border || "border-gray-300/20 dark:border-white/10",
            "min-h-[240px]",
            className,
          )}
          {...props}
        >
          {/* Top edge light with glow */}
          <div
            className={cn(
              "absolute inset-x-0 top-0 h-[2px] pointer-events-none z-10",
              glassCard.edgeLit.position.top,
              glassCard.edgeLit.color[edgeColor].line,
              glassCard.edgeLit.color[edgeColor].glow,
            )}
          />
          {/* Glow bleeding down */}
          <div
            className={cn(
              "absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent blur-lg pointer-events-none z-10",
              glassCard.edgeLit.color[edgeColor].gradient.vertical,
            )}
          />

          {/* Content wrapper with flex layout */}
          <div
            className={cn(
              "flex flex-col min-h-[240px]",
              glassCard.blur[blur],
              glassCard.tints[edgeColor]?.light || glassCard.transparency[transparency],
            )}
          >
            {children}
          </div>
        </div>
      );
    }

    // Standard card (no edge-lit)
    const glowClasses = !hasEdge && hasGlow ? [glowVariant.border, glowVariant.glow, glowVariant.hover] : [];

    return (
      <div
        ref={ref}
        className={cn(
          "relative rounded-xl overflow-hidden min-h-[240px]",
          glassCard.blur[blur],
          glassCard.transparency[transparency],
          "flex flex-col",
          hasGlow ? "" : "border border-gray-300/20 dark:border-white/10",
          ...glowClasses,
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

DataCard.displayName = "DataCard";

// Header component
export const DataCardHeader = React.forwardRef<HTMLDivElement, DataCardHeaderProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("relative p-4 pb-2", className)} {...props}>
        {children}
      </div>
    );
  },
);

DataCardHeader.displayName = "DataCardHeader";

// Content component (flexible - grows to fill space)
export const DataCardContent = React.forwardRef<HTMLDivElement, DataCardContentProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("flex-1 px-4", className)} {...props}>
        {children}
      </div>
    );
  },
);

DataCardContent.displayName = "DataCardContent";

// Footer component (anchored to bottom)
export const DataCardFooter = React.forwardRef<HTMLDivElement, DataCardFooterProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "px-4 py-3 bg-gray-100/50 dark:bg-black/30 border-t border-gray-200/50 dark:border-white/10",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

DataCardFooter.displayName = "DataCardFooter";
