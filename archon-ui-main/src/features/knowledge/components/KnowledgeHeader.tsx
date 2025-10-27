/**
 * Knowledge Base Header Component
 * Contains search, filters, and view controls
 */

import { Asterisk, BookOpen, Briefcase, Grid, List, Plus, Search, Terminal } from "lucide-react";
import { Button, Input, ToggleGroup, ToggleGroupItem } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";

interface KnowledgeHeaderProps {
  totalItems: number;
  isLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  typeFilter: "all" | "technical" | "business";
  onTypeFilterChange: (type: "all" | "technical" | "business") => void;
  viewMode: "grid" | "table";
  onViewModeChange: (mode: "grid" | "table") => void;
  onAddKnowledge: () => void;
}

export const KnowledgeHeader: React.FC<KnowledgeHeaderProps> = ({
  totalItems,
  isLoading,
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  viewMode,
  onViewModeChange,
  onAddKnowledge,
}) => {
  return (
    <div className="flex flex-col gap-4 px-6 py-4 border-b border-white/10">
      {/* Row 1: Title and Add Button (always on same line) */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-shrink-0">
          <BookOpen className="h-7 w-7 text-purple-500 filter drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]" />
          <h1 className="text-2xl font-bold text-white">Knowledge Base</h1>
          <span className="px-3 py-1 text-sm bg-black/30 border border-white/10 rounded">
            {isLoading ? "Loading..." : `${totalItems} items`}
          </span>
        </div>

        {/* Add knowledge button - stays on top line */}
        <Button variant="knowledge" onClick={onAddKnowledge} className="shadow-lg shadow-purple-500/30 flex-shrink-0">
          <Plus className="w-4 h-4 mr-2" />
          Knowledge
        </Button>
      </div>

      {/* Row 2: Search and Filters (wraps on smaller screens) */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative w-full sm:w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search knowledge base..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 bg-black/30 dark:bg-black/30 border-white/10 dark:border-white/10 focus:border-cyan-500/50"
          />
        </div>

        {/* Segmented type filters */}
        <ToggleGroup
          type="single"
          size="sm"
          value={typeFilter}
          onValueChange={(v) => v && onTypeFilterChange(v as "all" | "technical" | "business")}
          aria-label="Filter knowledge type"
        >
          <ToggleGroupItem value="all" aria-label="All" title="All" className="flex items-center justify-center">
            <Asterisk className="w-4 h-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="technical"
            aria-label="Technical"
            title="Technical"
            className="flex items-center justify-center"
          >
            <Terminal className="w-4 h-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="business"
            aria-label="Business"
            title="Business"
            className="flex items-center justify-center"
          >
            <Briefcase className="w-4 h-4" aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>

        {/* View Mode Toggle */}
        <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewModeChange("grid")}
            aria-label="Grid view"
            aria-pressed={viewMode === "grid"}
            title="Grid view"
            className={cn(
              "px-3",
              viewMode === "grid"
                ? "bg-cyan-500/20 dark:bg-cyan-500/20 text-cyan-400"
                : "text-gray-400 hover:text-white",
            )}
          >
            <Grid className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewModeChange("table")}
            aria-label="Table view"
            aria-pressed={viewMode === "table"}
            title="Table view"
            className={cn(
              "px-3",
              viewMode === "table"
                ? "bg-cyan-500/20 dark:bg-cyan-500/20 text-cyan-400"
                : "text-gray-400 hover:text-white",
            )}
          >
            <List className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
};
