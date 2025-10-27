import type { ReactNode } from "react";
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
  return (
    <div className="w-32 flex-shrink-0">
      <div className="sticky top-4 space-y-0.5">
        {sections.map((section) => {
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSectionClick(section.id)}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded-md transition-all duration-200",
                "flex items-center gap-1.5",
                isActive
                  ? "bg-blue-500/10 dark:bg-blue-400/10 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500"
                  : "text-gray-600 dark:text-gray-400 hover:bg-white/5 dark:hover:bg-white/5 border-l-2 border-transparent",
              )}
            >
              {section.icon && <span className="flex-shrink-0 w-3 h-3">{section.icon}</span>}
              <span className="text-xs font-medium truncate">{section.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
