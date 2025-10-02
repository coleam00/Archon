/**
 * Knowledge Type Selection Component
 * Radio cards for Technical vs Business knowledge type selection
 */

import { motion } from "framer-motion";
import { Briefcase, Check, Terminal } from "lucide-react";
import { cn } from "../../ui/primitives/styles";

interface KnowledgeTypeSelectorProps {
  value: "technical" | "business";
  onValueChange: (value: "technical" | "business") => void;
  disabled?: boolean;
}

const TYPES = [
  {
    value: "technical" as const,
    label: "Technical",
    description: "Code, APIs, dev docs",
    icon: Terminal,
    gradient: {
      selected:
        "from-cyan-100/60 via-cyan-50/30 to-white/70 dark:from-cyan-900/30 dark:via-cyan-900/15 dark:to-black/40",
      unselected:
        "from-gray-50/50 via-gray-25/25 to-white/60 dark:from-gray-800/20 dark:via-gray-800/10 dark:to-black/30",
    },
    border: {
      selected: "border-cyan-500/60",
      unselected: "border-gray-300/50 dark:border-gray-700/50",
      hover: "hover:border-cyan-400/50",
    },
    colors: {
      selected: "text-cyan-700 dark:text-cyan-400",
      unselected: "text-gray-700 dark:text-gray-300",
      description: {
        selected: "text-cyan-600 dark:text-cyan-400",
        unselected: "text-gray-500 dark:text-gray-400",
      },
    },
    accent: "bg-cyan-500",
    smear: "from-cyan-500/25",
  },
  {
    value: "business" as const,
    label: "Business",
    description: "Guides, policies, general",
    icon: Briefcase,
    gradient: {
      selected:
        "from-pink-100/60 via-pink-50/30 to-white/70 dark:from-pink-900/30 dark:via-pink-900/15 dark:to-black/40",
      unselected:
        "from-gray-50/50 via-gray-25/25 to-white/60 dark:from-gray-800/20 dark:via-gray-800/10 dark:to-black/30",
    },
    border: {
      selected: "border-pink-500/60",
      unselected: "border-gray-300/50 dark:border-gray-700/50",
      hover: "hover:border-pink-400/50",
    },
    colors: {
      selected: "text-pink-700 dark:text-pink-400",
      unselected: "text-gray-700 dark:text-gray-300",
      description: {
        selected: "text-pink-600 dark:text-pink-400",
        unselected: "text-gray-500 dark:text-gray-400",
      },
    },
    accent: "bg-pink-500",
    smear: "from-pink-500/25",
  },
];

export const KnowledgeTypeSelector: React.FC<KnowledgeTypeSelectorProps> = ({
  value,
  onValueChange,
  disabled = false,
}) => {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-gray-900 dark:text-white/90">Knowledge Type</div>
      <div className="grid grid-cols-2 gap-4">
        {TYPES.map((type) => {
          const isSelected = value === type.value;
          const Icon = type.icon;

          return (
            <motion.div
              key={type.value}
              whileHover={!disabled ? { scale: 1.02 } : {}}
              whileTap={!disabled ? { scale: 0.98 } : {}}
            >
              <button
                type="button"
                onClick={() => !disabled && onValueChange(type.value)}
                disabled={disabled}
                className={cn(
                  "relative w-full h-24 rounded-xl transition-all duration-200 border-2",
                  "flex flex-col items-center justify-center gap-2 p-4",
                  "backdrop-blur-md",
                  isSelected
                    ? `${type.border.selected} bg-gradient-to-b ${type.gradient.selected}`
                    : `${type.border.unselected} bg-gradient-to-b ${type.gradient.unselected}`,
                  !disabled && !isSelected && type.border.hover,
                  !disabled &&
                    !isSelected &&
                    "hover:shadow-[0_0_15px_rgba(0,0,0,0.05)] dark:hover:shadow-[0_0_15px_rgba(255,255,255,0.05)]",
                  isSelected && "shadow-[0_0_20px_rgba(6,182,212,0.15)]",
                  disabled && "opacity-50 cursor-not-allowed",
                )}
                aria-label={`Select ${type.label}: ${type.description}`}
              >
                {/* Top accent glow for selected state */}
                {isSelected && (
                  <div className="pointer-events-none absolute inset-x-0 top-0">
                    <div className={cn("mx-1 mt-0.5 h-[2px] rounded-full", type.accent)} />
                    <div className={cn("-mt-1 h-6 w-full bg-gradient-to-b to-transparent blur-md", type.smear)} />
                  </div>
                )}

                {/* Selection indicator */}
                {isSelected && (
                  <div
                    className={cn(
                      "absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center",
                      type.accent,
                    )}
                  >
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}

                {/* Icon */}
                <Icon className={cn("w-6 h-6", isSelected ? type.colors.selected : type.colors.unselected)} />

                {/* Label */}
                <div
                  className={cn("text-sm font-semibold", isSelected ? type.colors.selected : type.colors.unselected)}
                >
                  {type.label}
                </div>

                {/* Description */}
                <div
                  className={cn(
                    "text-xs text-center leading-tight",
                    isSelected ? type.colors.description.selected : type.colors.description.unselected,
                  )}
                >
                  {type.description}
                </div>
              </button>
            </motion.div>
          );
        })}
      </div>

      {/* Help text */}
      <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
        Choose the type that best describes your content
      </div>
    </div>
  );
};
