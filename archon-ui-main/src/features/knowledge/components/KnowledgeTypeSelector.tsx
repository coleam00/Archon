/**
 * Knowledge Type Selection Component
 * Radio cards for Technical vs Business knowledge type selection
 */

import { motion } from "framer-motion";
import { Briefcase, Terminal } from "lucide-react";
import { cn, glassCard } from "../../ui/primitives/styles";

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
    edgeColor: "cyan" as const,
    colors: {
      icon: "text-cyan-700 dark:text-cyan-400",
      label: "text-cyan-700 dark:text-cyan-400",
      description: "text-cyan-600 dark:text-cyan-400",
    },
  },
  {
    value: "business" as const,
    label: "Business",
    description: "Guides, policies, general",
    icon: Briefcase,
    edgeColor: "purple" as const,
    colors: {
      icon: "text-purple-700 dark:text-purple-400",
      label: "text-purple-700 dark:text-purple-400",
      description: "text-purple-600 dark:text-purple-400",
    },
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
                  "relative w-full h-24 rounded-xl transition-all duration-200",
                  "flex flex-col items-center justify-center gap-2 p-4",
                  glassCard.base,
                  isSelected
                    ? glassCard.edgeColors[type.edgeColor].border
                    : "border border-gray-300/50 dark:border-gray-700/50",
                  isSelected ? glassCard.tints[type.edgeColor].light : glassCard.transparency.light,
                  !isSelected && "hover:border-gray-400/60 dark:hover:border-gray-600/60",
                  disabled && "opacity-50 cursor-not-allowed",
                )}
                aria-label={`Select ${type.label}: ${type.description}`}
              >
                {/* Top edge-lit effect for selected state */}
                {isSelected && (
                  <>
                    <div
                      className={cn(
                        "absolute inset-x-0 top-0 h-[2px] pointer-events-none z-10",
                        glassCard.edgeLit.position.top,
                        glassCard.edgeLit.color[type.edgeColor].line,
                        glassCard.edgeLit.color[type.edgeColor].glow,
                      )}
                    />
                    <div
                      className={cn(
                        "absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent blur-lg pointer-events-none z-10",
                        glassCard.edgeLit.color[type.edgeColor].gradient.vertical,
                      )}
                    />
                  </>
                )}

                {/* Icon */}
                <Icon
                  className={cn("w-6 h-6", isSelected ? type.colors.icon : "text-gray-700 dark:text-gray-300")}
                  aria-hidden="true"
                />

                {/* Label */}
                <div
                  className={cn(
                    "text-sm font-semibold",
                    isSelected ? type.colors.label : "text-gray-700 dark:text-gray-300",
                  )}
                >
                  {type.label}
                </div>

                {/* Description */}
                <div
                  className={cn(
                    "text-xs text-center leading-tight",
                    isSelected ? type.colors.description : "text-gray-500 dark:text-gray-400",
                  )}
                >
                  {type.description}
                </div>
              </button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
