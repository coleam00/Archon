/**
 * Level Selection Component
 * Circular level selector for crawl depth using radio-like selection
 */

import { motion } from "framer-motion";
import { Check, Info } from "lucide-react";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";

interface LevelSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

const LEVELS = [
  {
    value: "1",
    label: "1",
    description: "Single page only",
    details: "1-50 pages • Best for: Single articles, specific pages",
  },
  {
    value: "2",
    label: "2",
    description: "Page + immediate links",
    details: "10-200 pages • Best for: Documentation sections, blogs",
  },
  {
    value: "3",
    label: "3",
    description: "2 levels deep",
    details: "50-500 pages • Best for: Entire sites, comprehensive docs",
  },
  {
    value: "5",
    label: "5",
    description: "Very deep crawling",
    details: "100-1000+ pages • Warning: May include irrelevant content",
  },
];

export const LevelSelector: React.FC<LevelSelectorProps> = ({ value, onValueChange, disabled = false }) => {
  const tooltipContent = (
    <div className="space-y-2 text-xs">
      <div className="font-semibold mb-2">Crawl Depth Level Explanations:</div>
      {LEVELS.map((level) => (
        <div key={level.value} className="space-y-1">
          <div className="font-medium">
            Level {level.value}: "{level.description}"
          </div>
          <div className="text-gray-300 dark:text-gray-400 pl-2">{level.details}</div>
        </div>
      ))}
      <div className="mt-3 pt-2 border-t border-gray-600 dark:border-gray-400">
        <div className="flex items-center gap-1">
          <span>💡</span>
          <span className="font-medium">More data isn't always better. Choose based on your needs.</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-gray-900 dark:text-white/90" id="crawl-depth-label">
          Crawl Depth
        </div>
        <SimpleTooltip content={tooltipContent}>
          <Info className="w-4 h-4 text-gray-400 hover:text-cyan-500 transition-colors cursor-help" />
        </SimpleTooltip>
      </div>
      <div className="grid grid-cols-4 gap-3" role="radiogroup" aria-labelledby="crawl-depth-label">
        {LEVELS.map((level) => {
          const isSelected = value === level.value;

          return (
            <motion.div
              key={level.value}
              whileHover={!disabled ? { scale: 1.05 } : {}}
              whileTap={!disabled ? { scale: 0.95 } : {}}
            >
              <SimpleTooltip content={level.details}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`Level ${level.value}: ${level.description}`}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => !disabled && onValueChange(level.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (!disabled) onValueChange(level.value);
                    }
                  }}
                  disabled={disabled}
                  className={cn(
                    "relative w-full h-16 rounded-xl transition-all duration-200 border-2",
                    "flex flex-col items-center justify-center gap-1",
                    "backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2",
                    isSelected
                      ? "border-cyan-500/60 bg-gradient-to-b from-cyan-100/60 via-cyan-50/30 to-white/70 dark:from-cyan-900/30 dark:via-cyan-900/15 dark:to-black/40"
                      : "border-gray-300/50 dark:border-gray-700/50 bg-gradient-to-b from-gray-50/50 via-gray-25/25 to-white/60 dark:from-gray-800/20 dark:via-gray-800/10 dark:to-black/30",
                    !disabled && "hover:border-cyan-400/50 hover:shadow-[0_0_15px_rgba(6,182,212,0.15)]",
                    disabled && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {/* Top accent glow for selected state */}
                  {isSelected && (
                    <div className="pointer-events-none absolute inset-x-0 top-0">
                      <div className="mx-1 mt-0.5 h-[2px] rounded-full bg-cyan-500" />
                      <div className="-mt-1 h-6 w-full bg-gradient-to-b from-cyan-500/25 to-transparent blur-md" />
                    </div>
                  )}

                  {/* Selection indicator */}
                  {isSelected && (
                    <div className="absolute -top-1 -right-1 w-5 h-5 bg-cyan-500 rounded-full flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}

                  {/* Level number */}
                  <div
                    className={cn(
                      "text-lg font-bold",
                      isSelected ? "text-cyan-700 dark:text-cyan-400" : "text-gray-700 dark:text-gray-300",
                    )}
                  >
                    {level.label}
                  </div>

                  {/* Level description */}
                  <div
                    className={cn(
                      "text-xs text-center leading-tight",
                      isSelected ? "text-cyan-600 dark:text-cyan-400" : "text-gray-500 dark:text-gray-400",
                    )}
                  >
                    {level.value === "1" ? "level" : "levels"}
                  </div>
                </button>
              </SimpleTooltip>
            </motion.div>
          );
        })}
      </div>

      {/* Help text */}
      <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
        Higher levels crawl deeper into the website structure
      </div>
    </div>
  );
};
