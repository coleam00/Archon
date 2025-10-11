/**
 * Level Selection Component
 * Circular level selector for crawl depth using radio-like selection
 */

import { motion } from "framer-motion";
import { Info } from "lucide-react";
import { cn, glassCard } from "../../ui/primitives/styles";
import { SimpleTooltip, Tooltip, TooltipContent, TooltipTrigger } from "../../ui/primitives/tooltip";

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
    <div className="space-y-2 max-w-xs">
      <div className="font-semibold mb-2 text-sm">Crawl Depth Levels:</div>
      {LEVELS.map((level) => (
        <div key={level.value} className="space-y-0.5">
          <div className="text-xs font-medium">
            Level {level.value}: {level.description}
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500 pl-2">{level.details}</div>
        </div>
      ))}
      <div className="mt-2 pt-2 border-t border-gray-600 dark:border-gray-500 text-xs">
        💡 More data isn't always better. Choose based on your needs.
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-gray-900 dark:text-white/90" id="crawl-depth-label">
            Crawl Depth
          </div>
          <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-gray-400 hover:text-cyan-500 transition-colors cursor-help"
              aria-label="Show crawl depth level details"
            >
              <Info className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{tooltipContent}</TooltipContent>
        </Tooltip>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Higher levels crawl deeper into the website structure
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" role="radiogroup" aria-labelledby="crawl-depth-label">
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
                    "relative w-full h-16 rounded-xl transition-all duration-200",
                    "flex flex-col items-center justify-center gap-1",
                    glassCard.base,
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2",
                    isSelected ? glassCard.edgeColors.cyan.border : "border border-gray-300/50 dark:border-gray-700/50",
                    isSelected ? glassCard.tints.cyan.light : glassCard.transparency.light,
                    !disabled && !isSelected && "hover:border-cyan-400/50",
                    disabled && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {/* Top edge-lit effect for selected state */}
                  {isSelected && (
                    <>
                      <div
                        className={cn(
                          "absolute inset-x-0 top-0 h-[2px] pointer-events-none z-10",
                          glassCard.edgeLit.position.top,
                          glassCard.edgeLit.color.cyan.line,
                          glassCard.edgeLit.color.cyan.glow,
                        )}
                      />
                      <div
                        className={cn(
                          "absolute inset-x-0 top-0 h-16 bg-gradient-to-b to-transparent blur-lg pointer-events-none z-10",
                          glassCard.edgeLit.color.cyan.gradient.vertical,
                        )}
                      />
                    </>
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
    </div>
  );
};
