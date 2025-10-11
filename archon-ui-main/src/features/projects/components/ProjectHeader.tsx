import { motion } from "framer-motion";
import { LayoutGrid, List, Plus, Search, X } from "lucide-react";
import type React from "react";
import { ReactNode } from "react";
import { Button } from "../../ui/primitives/button";
import { Input } from "../../ui/primitives/input";
import { cn } from "../../ui/primitives/styles";

interface ProjectHeaderProps {
  onNewProject: () => void;
  layoutMode?: "horizontal" | "sidebar";
  onLayoutModeChange?: (mode: "horizontal" | "sidebar") => void;
  rightContent?: ReactNode;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
}

const titleVariants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export const ProjectHeader: React.FC<ProjectHeaderProps> = ({
  onNewProject,
  layoutMode,
  onLayoutModeChange,
  rightContent,
  searchQuery,
  onSearchChange,
}) => {
  return (
    <motion.div
      className="flex items-center justify-between mb-8"
      variants={itemVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.h1
        className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3"
        variants={titleVariants}
      >
        <img
          src="/logo-neon.png"
          alt="Projects"
          className="w-7 h-7 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]"
        />
        Projects
      </motion.h1>
      <div className="flex items-center gap-3">
        {/* Search input */}
        {searchQuery !== undefined && onSearchChange && (
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-9 pr-8"
              aria-label="Search projects"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        {/* Layout toggle - show if mode and change handler provided */}
        {layoutMode && onLayoutModeChange && (
          <div className="flex gap-1 p-1 bg-black/30 dark:bg-black/50 rounded-lg border border-white/10">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLayoutModeChange("horizontal")}
              className={cn("px-3", layoutMode === "horizontal" && "bg-purple-500/20 text-purple-400")}
              aria-label="Switch to horizontal layout"
              aria-pressed={layoutMode === "horizontal"}
            >
              <LayoutGrid className="w-4 h-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLayoutModeChange("sidebar")}
              className={cn("px-3", layoutMode === "sidebar" && "bg-purple-500/20 text-purple-400")}
              aria-label="Switch to sidebar layout"
              aria-pressed={layoutMode === "sidebar"}
            >
              <List className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        )}
        {rightContent}
        <Button onClick={onNewProject} variant="cyan" className="shadow-lg shadow-cyan-500/20">
          <Plus className="w-4 h-4 mr-2" />
          New Project
        </Button>
      </div>
    </motion.div>
  );
};
