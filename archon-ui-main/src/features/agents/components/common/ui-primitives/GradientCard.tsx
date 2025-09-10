/**
 * GradientCard Component
 *
 * Reusable card component with Tron-inspired gradient backgrounds and borders
 * Replaces repeated gradient styling patterns throughout the app
 *
 * Note: Inline styles are used for complex gradients that cannot be easily
 * represented with Tailwind CSS classes
 */

import type React from "react";
import {
  getCardStyle,
  getBorderStyle,
  type CardGradients,
} from "../styles/gradientStyles";
import { cn, getCardClasses } from "../utils/classNameHelpers";

export interface GradientCardProps {
  children: React.ReactNode;
  theme?: keyof CardGradients;
  className?: string;
  isActive?: boolean;
  isHoverable?: boolean;
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
  role?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export const GradientCard: React.FC<GradientCardProps> = ({
  children,
  theme = "inactive",
  className = "",
  isActive = false,
  isHoverable = true,
  onClick,
  size = "md",
  role,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}) => {
  // Auto-determine theme based on active state if not explicitly provided
  const effectiveTheme = isActive && theme === "inactive" ? "active" : theme;

  // Valid ARIA roles for cards
  const validAriaRoles = [
    "region",
    "article",
    "section",
    "main",
    "complementary",
    "navigation",
    "banner",
    "contentinfo",
  ];
  const effectiveRole =
    role && validAriaRoles.includes(role) ? role : undefined;

  return (
    <div
      className={cn(getCardClasses(isActive, isHoverable, size), className)}
      style={getCardStyle(effectiveTheme)}
      onClick={onClick}
      role={effectiveRole}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
    >
      {/* Gradient Border */}
      <div
        className="absolute inset-0 rounded-xl p-[1px] transition-all duration-300 pointer-events-none"
        style={getBorderStyle(effectiveTheme)}
      >
        <div
          className="w-full h-full rounded-xl"
          style={getCardStyle(effectiveTheme)}
        />
      </div>

      {/* Content */}
      <div className="relative">{children}</div>
    </div>
  );
};
