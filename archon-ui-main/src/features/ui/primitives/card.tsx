import React from "react";
import { cn, glassCard } from "./styles";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  // Glass properties
  blur?: "none" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  transparency?: "clear" | "light" | "medium" | "frosted" | "solid";
  glassTint?: "none" | "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";

  // Glow properties (uses pre-defined static classes from styles.ts)
  glowColor?: "none" | "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";
  glowType?: "outer" | "inner";
  glowSize?: "sm" | "md" | "lg" | "xl";

  // Edge-lit properties
  edgePosition?: "none" | "top" | "left" | "right" | "bottom";
  edgeColor?: "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";

  // Size (padding)
  size?: "none" | "sm" | "md" | "lg" | "xl";
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      className,
      blur = "md",
      transparency = "light",
      glassTint = "none",
      glowColor = "none",
      glowType = "outer",
      glowSize = "md",
      edgePosition = "none",
      edgeColor = "cyan",
      size = "md",
      children,
      ...props
    },
    ref,
  ) => {
    const hasEdge = edgePosition !== "none";
    const hasGlow = glowColor !== "none";

    // Use pre-defined static classes from styles.ts
    const glowVariant = glassCard.variants[glowColor] || glassCard.variants.none;

    // Get glow class from static lookups in styles.ts
    const getGlowClass = () => {
      if (!hasGlow || hasEdge) return "";

      if (glowType === "inner") {
        return glassCard.innerGlowSizes?.[glowColor]?.[glowSize] || "";
      }

      // Outer glow
      return glassCard.outerGlowSizes?.[glowColor]?.[glowSize] || glowVariant.glow;
    };

    // Get size-matched hover glow class
    const getHoverGlowClass = () => {
      if (!hasGlow || hasEdge) return "";

      if (glowType === "inner") {
        return glassCard.innerGlowHover?.[glowColor]?.[glowSize] || "";
      }

      // Outer glow hover
      return glassCard.outerGlowHover?.[glowColor]?.[glowSize] || glowVariant.hover;
    };

    const edgeStyle = glassCard.edgeColors[edgeColor];

    if (hasEdge) {
      // Edge-lit card with actual div elements (not pseudo-elements)
      // Extract flex/layout classes from className to apply to inner content div
      const flexClasses =
        className?.match(/(flex|flex-col|flex-row|flex-1|items-\S+|justify-\S+|gap-\S+)/g)?.join(" ") || "";
      const otherClasses =
        className?.replace(/(flex|flex-col|flex-row|flex-1|items-\S+|justify-\S+|gap-\S+)/g, "").trim() || "";

      // Edge line and glow configuration per position
      const edgeConfig = {
        top: {
          line: "absolute inset-x-0 top-0 h-[2px]",
          glow: "absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent",
        },
        bottom: {
          line: "absolute inset-x-0 bottom-0 h-[2px]",
          glow: "absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent",
        },
        left: {
          line: "absolute inset-y-0 left-0 w-[2px]",
          glow: "absolute inset-y-0 left-0 w-16 bg-gradient-to-r to-transparent",
        },
        right: {
          line: "absolute inset-y-0 right-0 w-[2px]",
          glow: "absolute inset-y-0 right-0 w-16 bg-gradient-to-l to-transparent",
        },
      };

      const config = edgeConfig[edgePosition];

      return (
        <div ref={ref} className={cn("relative rounded-xl overflow-hidden", edgeStyle.border, otherClasses)} {...props}>
          {/* Edge light bar */}
          <div className={cn(config.line, "pointer-events-none z-10", edgeStyle.solid)} />
          {/* Glow bleeding into card */}
          <div className={cn(config.glow, "blur-lg pointer-events-none z-10", edgeStyle.gradient)} />
          {/* Content with tinted background - INHERIT flex classes */}
          <div className={cn("backdrop-blur-sm", edgeStyle.bg, glassCard.sizes[size], flexClasses)}>{children}</div>
        </div>
      );
    }

    // Standard card (no edge-lit) - use static classes from styles.ts
    return (
      <div
        ref={ref}
        className={cn(
          glassCard.base,
          glassCard.blur[blur],
          glassTint !== "none" ? glassCard.tints[glassTint][transparency] : glassCard.transparency[transparency],
          glassCard.sizes[size],
          // Border and glow classes from static lookups
          !hasEdge && glowVariant.border,
          !hasEdge && getGlowClass(),
          !hasEdge && getHoverGlowClass(), // Size-matched hover
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = "Card";
