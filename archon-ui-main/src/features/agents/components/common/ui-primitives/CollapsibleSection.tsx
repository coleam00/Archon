/**
 * CollapsibleSection Component
 * 
 * Reusable collapsible section with gradient styling
 * Extracted from AgentsPage to reduce complexity
 */

import React from "react";
import { ChevronDown } from "lucide-react";
import { GradientCard } from "./GradientCard";
import { cn } from "../utils/classNameHelpers";

export interface CollapsibleSectionProps {
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
  badge?: React.ReactNode;
  autoExpandOnEmpty?: boolean;
  maxContentHeight?: string;
  theme?: "inactive" | "active" | "warning" | "success" | "error";
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  subtitle,
  icon,
  isExpanded,
  onToggle,
  children,
  className = "",
  badge,
  autoExpandOnEmpty = false,
  maxContentHeight = "600px",
  theme = "inactive",
}) => {
  // Auto-expand behavior: only expand when children are actually empty
  const isEmptyChildren = React.Children.toArray(children).filter(Boolean).length === 0;
  const shouldExpand = isExpanded || (autoExpandOnEmpty && isEmptyChildren);

  return (
    <div className={cn("mb-8", className)}>
      <GradientCard
        theme={shouldExpand ? "active" : theme}
        isActive={shouldExpand}
        onClick={() => !shouldExpand && onToggle()}
        className="cursor-pointer"
      >
        {/* Collapsible Header */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="relative w-full p-4 flex items-center justify-between group"
        >
          <div className="flex items-center gap-3">
            {icon && (
              <div
                className={cn(
                  "w-10 h-10 rounded-lg flex items-center justify-center transition-all",
                  shouldExpand
                    ? "bg-gradient-to-br from-purple-600/30 to-purple-500/20 border border-purple-500/30"
                    : "bg-zinc-800/50 border border-zinc-700/50"
                )}
              >
                <div className={cn(shouldExpand ? "text-purple-400" : "text-gray-400")}>
                  {icon}
                </div>
              </div>
            )}
            
            <div className="text-left">
              <h2 className="text-sm font-light text-white">{title}</h2>
              {subtitle && (
                <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {badge}
            <ChevronDown
              className={cn(
                "w-5 h-5 text-gray-400 transition-transform group-hover:text-gray-300",
                shouldExpand && "rotate-180"
              )}
            />
          </div>
        </button>

        {/* Expanded Content */}
        {shouldExpand && (
          <div className="relative px-4 pb-4">
            <div className="border-t border-zinc-800/50 pt-4">
              <div 
                className="overflow-y-auto pr-2 custom-scrollbar p-1"
                style={{ maxHeight: maxContentHeight }}
              >
                {children}
              </div>
            </div>
          </div>
        )}
      </GradientCard>
    </div>
  );
};