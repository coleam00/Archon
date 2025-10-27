import type React from "react";
import { cn } from "./styles";

export type PillColor = "blue" | "orange" | "cyan" | "purple" | "pink" | "green" | "gray";

export interface StatPillProps extends React.HTMLAttributes<HTMLDivElement> {
  color?: PillColor;
  value: number | string;
  icon?: React.ReactNode;
  size?: "sm" | "md";
}

// Static maps hoisted outside component to avoid re-allocation on each render
const SIZE_MAP = {
  sm: "h-6 px-2 text-[11px] gap-1",
  md: "h-7 px-2.5 text-xs gap-1.5",
} as const;

const COLOR_MAP: Record<PillColor, { bg: string; text: string; border: string; glow: string }> = {
  blue: {
    bg: "from-blue-100/80 to-white/60 dark:from-blue-500/20 dark:to-blue-500/10",
    text: "text-blue-700 dark:text-blue-200",
    border: "border-blue-300/60 dark:border-blue-500/50",
    glow: "shadow-[0_0_10px_rgba(59,130,246,0.35)]",
  },
  orange: {
    bg: "from-orange-100/80 to-white/60 dark:from-orange-500/20 dark:to-orange-500/10",
    text: "text-orange-700 dark:text-orange-200",
    border: "border-orange-300/60 dark:border-orange-500/50",
    glow: "shadow-[0_0_10px_rgba(249,115,22,0.35)]",
  },
  cyan: {
    bg: "from-cyan-100/80 to-white/60 dark:from-cyan-500/20 dark:to-cyan-500/10",
    text: "text-cyan-700 dark:text-cyan-200",
    border: "border-cyan-300/60 dark:border-cyan-500/50",
    glow: "shadow-[0_0_10px_rgba(34,211,238,0.35)]",
  },
  purple: {
    bg: "from-purple-100/80 to-white/60 dark:from-purple-500/20 dark:to-purple-500/10",
    text: "text-purple-700 dark:text-purple-200",
    border: "border-purple-300/60 dark:border-purple-500/50",
    glow: "shadow-[0_0_10px_rgba(168,85,247,0.35)]",
  },
  pink: {
    bg: "from-pink-100/80 to-white/60 dark:from-pink-500/20 dark:to-pink-500/10",
    text: "text-pink-700 dark:text-pink-200",
    border: "border-pink-300/60 dark:border-purple-500/50",
    glow: "shadow-[0_0_10px_rgba(236,72,153,0.35)]",
  },
  green: {
    bg: "from-green-100/80 to-white/60 dark:from-green-500/20 dark:to-green-500/10",
    text: "text-green-700 dark:text-green-200",
    border: "border-green-300/60 dark:border-green-500/50",
    glow: "shadow-[0_0_10px_rgba(34,197,94,0.35)]",
  },
  gray: {
    bg: "from-gray-100/80 to-white/60 dark:from-gray-500/20 dark:to-gray-500/10",
    text: "text-gray-700 dark:text-gray-200",
    border: "border-gray-300/60 dark:border-gray-500/50",
    glow: "shadow-[0_0_6px_rgba(148,163,184,0.35)]",
  },
};

/**
 * StatPill — rounded glass/stat indicator with neon accents.
 * Used for compact counters inside cards (docs, examples, etc.).
 */
export const StatPill: React.FC<StatPillProps> = ({
  color = "blue",
  value,
  icon,
  size = "sm",
  className,
  ...props
}) => {
  const c = COLOR_MAP[color];

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full backdrop-blur-md border",
        "bg-gradient-to-b",
        c.bg,
        c.text,
        c.border,
        c.glow,
        SIZE_MAP[size],
        className,
      )}
      {...props}
    >
      {icon && (
        <span className="inline-flex items-center" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
};
