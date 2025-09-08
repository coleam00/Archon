/**
 * Knowledge Base Header Component
 * Contains search, filters, and view controls
 */

import { BookOpen, Filter, Grid, List, Plus, Search } from "lucide-react";
import { Button, Input } from "../../ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/primitives/select";
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
      {/* Title and Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen className="w-6 h-6 text-cyan-400" />
          <h1 className="text-2xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
            Knowledge Base
          </h1>
          <span className="px-3 py-1 text-sm bg-black/30 border border-white/10 rounded glass-morphism">
            {isLoading ? "Loading..." : `${totalItems} items`}
          </span>
        </div>

        <Button
          onClick={onAddKnowledge}
          className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Knowledge
        </Button>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-4">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search knowledge base..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 bg-black/30 border-white/10 focus:border-cyan-500/50"
          />
        </div>

        {/* Type Filter */}
        <Select
          value={typeFilter}
          onValueChange={(value) => onTypeFilterChange(value as "all" | "technical" | "business")}
        >
          <SelectTrigger className="w-[180px] bg-black/30 border-white/10">
            <Filter className="w-4 h-4 mr-2" />
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent className="glass-morphism">
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="technical">Technical</SelectItem>
            <SelectItem value="business">Business</SelectItem>
          </SelectContent>
        </Select>

        {/* View Mode Toggle */}
        <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewModeChange("grid")}
            className={cn(
              "px-3",
              viewMode === "grid" ? "bg-cyan-500/20 text-cyan-400" : "text-gray-400 hover:text-white",
            )}
          >
            <Grid className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewModeChange("table")}
            className={cn(
              "px-3",
              viewMode === "table" ? "bg-cyan-500/20 text-cyan-400" : "text-gray-400 hover:text-white",
            )}
          >
            <List className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
