import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { cn } from "@/features/ui/primitives/styles";

export interface SideNavigationSection {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface SideNavigationProps {
  sections: SideNavigationSection[];
  activeSection: string;
  onSectionClick: (sectionId: string) => void;
}

export const SideNavigation = ({ sections, activeSection, onSectionClick }: SideNavigationProps) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className={cn("flex-shrink-0 transition-all duration-300", isCollapsed ? "w-12" : "w-32")}>
      <div className="sticky top-4 space-y-0.5">
        {/* Collapse/Expand button */}
        <div className="mb-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="px-2 py-1 h-auto text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </Button>
        </div>
        {sections.map((section) => {
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSectionClick(section.id)}
              title={isCollapsed ? section.label : undefined}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded-md transition-all duration-200",
                "flex items-center gap-1.5",
                isActive
                  ? "bg-blue-500/10 dark:bg-blue-400/10 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500"
                  : "text-gray-600 dark:text-gray-400 hover:bg-white/5 dark:hover:bg-white/5 border-l-2 border-transparent",
                isCollapsed && "justify-center",
              )}
            >
              {section.icon && <span className="flex-shrink-0 w-3 h-3">{section.icon}</span>}
              {!isCollapsed && <span className="text-xs font-medium truncate">{section.label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};
