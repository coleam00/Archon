import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { cn } from "@/features/ui/primitives/styles";

export interface PillNavigationItem {
  id: string;
  label: string;
  icon?: ReactNode;
  items?: string[];
}

interface PillNavigationProps {
  items: PillNavigationItem[];
  activeSection: string;
  activeItem?: string;
  onSectionClick: (sectionId: string) => void;
  onItemClick?: (item: string) => void;
  colorVariant?: "blue" | "orange" | "cyan" | "purple" | "green";
  size?: "small" | "default" | "large";
  showIcons?: boolean;
  showText?: boolean;
  hasSubmenus?: boolean;
  openDropdown?: string | null;
}

export const PillNavigation = ({
  items,
  activeSection,
  activeItem,
  onSectionClick,
  onItemClick,
  colorVariant = "cyan",
  size = "default",
  showIcons = true,
  showText = true,
  hasSubmenus = true,
  openDropdown,
}: PillNavigationProps) => {
  const getColorClasses = (variant: string, isSelected: boolean) => {
    const colors = {
      blue: isSelected
        ? "bg-blue-500/20 dark:bg-blue-400/20 text-blue-700 dark:text-blue-300 border border-blue-400/50 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
        : "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
      orange: isSelected
        ? "bg-orange-500/20 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300 border border-orange-400/50 shadow-[0_0_10px_rgba(251,146,60,0.5)]"
        : "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
      cyan: isSelected
        ? "bg-cyan-500/20 dark:bg-cyan-400/20 text-cyan-700 dark:text-cyan-300 border border-cyan-400/50 shadow-[0_0_10px_rgba(34,211,238,0.5)]"
        : "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
      purple: isSelected
        ? "bg-purple-500/20 dark:bg-purple-400/20 text-purple-700 dark:text-purple-300 border border-purple-400/50 shadow-[0_0_10px_rgba(147,51,234,0.5)]"
        : "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
      green: isSelected
        ? "bg-green-500/20 dark:bg-green-400/20 text-green-700 dark:text-green-300 border border-green-400/50 shadow-[0_0_10px_rgba(34,197,94,0.5)]"
        : "text-gray-700 dark:text-gray-300 hover:bg-white/10 dark:hover:bg-white/5",
    };
    return colors[variant as keyof typeof colors] || colors.cyan;
  };

  const getSizeClasses = (sizeVariant: string) => {
    const sizes = {
      small: "px-4 py-2 text-xs",
      default: "px-6 py-3 text-sm",
      large: "px-8 py-4 text-base",
    };
    return sizes[sizeVariant as keyof typeof sizes] || sizes.default;
  };

  return (
    <div className="backdrop-blur-sm bg-white/40 dark:bg-white/5 border border-white/30 dark:border-white/15 rounded-full p-1 shadow-lg transition-all duration-300 ease-in-out">
      <div className="flex gap-1 items-center">
        {items.map((item) => {
          const isSelected = activeSection === item.id;
          const hasDropdown = hasSubmenus && item.items && item.items.length > 0;
          const isThisExpanded = openDropdown === item.id && hasDropdown;

          return (
            <div key={item.id} className="relative">
              {/* Extended pill for selected item with dropdown */}
              {isSelected && hasDropdown ? (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-full transition-all duration-200",
                    "font-medium whitespace-nowrap",
                    getSizeClasses(size),
                    getColorClasses(colorVariant, true),
                  )}
                >
                  {showIcons && item.icon}
                  {showText && item.label}

                  {/* Dropdown selector inside the pill */}
                  {onItemClick && (
                    <div className="flex items-center ml-4 pl-4 border-l border-current/30">
                      <Select value={activeItem || ""} onValueChange={onItemClick}>
                        <SelectTrigger
                          className="bg-transparent border-none outline-none font-medium cursor-pointer text-inherit w-auto px-0 hover:border-none focus:border-none focus:shadow-none"
                          showChevron={false}
                          color={colorVariant}
                        >
                          <SelectValue placeholder="Select..." />
                        </SelectTrigger>
                        <SelectContent color={colorVariant}>
                          {item.items?.map((subItem) => (
                            <SelectItem key={subItem} value={subItem} color={colorVariant}>
                              {subItem}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <button
                    type="button"
                    className={cn(
                      "ml-2 flex h-6 w-6 items-center justify-center rounded-full transition-transform duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-transparent focus:ring-current",
                      isThisExpanded ? "-rotate-90" : "rotate-0",
                    )}
                    aria-label={isThisExpanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
                    aria-expanded={isThisExpanded}
                    onClick={() => onSectionClick(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSectionClick(item.id);
                      }
                    }}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                /* Regular pill for non-selected items */
                <button
                  type="button"
                  onClick={() => onSectionClick(item.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-full transition-all duration-200",
                    "font-medium whitespace-nowrap",
                    getSizeClasses(size),
                    getColorClasses(colorVariant, isSelected),
                  )}
                >
                  {showIcons && item.icon}
                  {showText && item.label}
                  {hasDropdown && (
                    <ChevronRight
                      className={cn(
                        "w-4 h-4 transition-transform duration-300",
                        isThisExpanded ? "-rotate-90" : "rotate-0",
                      )}
                    />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
