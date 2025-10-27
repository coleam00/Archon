import { Asterisk, Calendar, Code, FileCode, FileText, Globe, Grid, List, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { DataCard, DataCardContent, DataCardFooter, DataCardHeader } from "@/features/ui/primitives/data-card";
import { GroupedCard } from "@/features/ui/primitives/grouped-card";
import { Input } from "@/features/ui/primitives/input";
import { StatPill } from "@/features/ui/primitives/pill";
import { cn } from "@/features/ui/primitives/styles";
import { ToggleGroup, ToggleGroupItem } from "@/features/ui/primitives/toggle-group";

const MOCK_KNOWLEDGE_ITEMS = [
  {
    id: "1",
    title: "React Documentation",
    type: "technical",
    url: "https://react.dev",
    date: "2024-01-15",
    chunks: 145,
    codeExamples: 23,
  },
  {
    id: "2",
    title: "Product Requirements",
    type: "business",
    url: null,
    date: "2024-01-20",
    chunks: 23,
    codeExamples: 0,
  },
  {
    id: "3",
    title: "FastAPI Guide",
    type: "technical",
    url: "https://fastapi.tiangolo.com",
    date: "2024-01-18",
    chunks: 89,
    codeExamples: 15,
  },
  {
    id: "4",
    title: "TailwindCSS Docs",
    type: "technical",
    url: "https://tailwindcss.com",
    date: "2024-01-22",
    chunks: 112,
    codeExamples: 31,
  },
  {
    id: "5",
    title: "Marketing Strategy",
    type: "business",
    url: null,
    date: "2024-01-10",
    chunks: 15,
    codeExamples: 0,
  },
  {
    id: "6",
    title: "TypeScript Handbook",
    type: "technical",
    url: "https://www.typescriptlang.org/docs",
    date: "2024-01-25",
    chunks: 203,
    codeExamples: 47,
  },
];

export const KnowledgeLayoutExample = () => {
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [typeFilter, setTypeFilter] = useState("all");

  const filteredItems = useMemo(() => {
    if (typeFilter === "all") return MOCK_KNOWLEDGE_ITEMS;
    return MOCK_KNOWLEDGE_ITEMS.filter((item) => item.type === typeFilter);
  }, [typeFilter]);

  return (
    <div className="space-y-4">
      {/* Explanation Text */}
      <p className="text-sm text-gray-600 dark:text-gray-400">
        <strong>Use this layout for:</strong> Switchable views (grid/table/list), filterable data, search interfaces.
        Users can toggle between dense (table) and spacious (grid) layouts.
      </p>

      {/* Header with Controls */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <Input placeholder="Search knowledge base..." className="max-w-xs" />

        <div className="flex gap-2 items-center">
          {/* Type Filter */}
          <ToggleGroup
            type="single"
            size="sm"
            value={typeFilter}
            onValueChange={(v) => v && setTypeFilter(v)}
            aria-label="Filter type"
          >
            <ToggleGroupItem value="all" aria-label="All" title="All">
              <Asterisk className="w-4 h-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="technical" aria-label="Technical" title="Technical">
              <Terminal className="w-4 h-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="business" aria-label="Business" title="Business">
              <FileCode className="w-4 h-4" />
            </ToggleGroupItem>
          </ToggleGroup>

          {/* View Toggle */}
          <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewMode("grid")}
              className={cn("px-3", viewMode === "grid" && "bg-cyan-500/20 text-cyan-400")}
            >
              <Grid className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewMode("table")}
              className={cn("px-3", viewMode === "table" && "bg-cyan-500/20 text-cyan-400")}
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Conditional View Rendering */}
      {viewMode === "grid" ? (
        // Grid View - Responsive columns
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredItems.map((item) => (
            <KnowledgeCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        // Table View - matching TaskView standard pattern
        <div className="w-full">
          <div className="overflow-x-auto scrollbar-hide">
            <table className="w-full">
              <thead>
                <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Title</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Type</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Source</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Chunks</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Date</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, index) => (
                  <KnowledgeTableRow key={item.id} item={item} index={index} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Grouped Card Example */}
      <div className="mt-8 space-y-4">
        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Grouped Knowledge Cards</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Multiple related items stacked together with progressive scaling and fading edge lights
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <GroupedCard
            cards={[
              { id: "1", title: "React Hooks Guide", edgeColor: "cyan" },
              { id: "2", title: "React Components", edgeColor: "cyan" },
              { id: "3", title: "React Patterns", edgeColor: "cyan" },
            ]}
            className="h-[280px]"
          />
          <GroupedCard
            cards={[
              { id: "4", title: "API Documentation", edgeColor: "purple" },
              { id: "5", title: "API Examples", edgeColor: "purple" },
            ]}
            className="h-[280px]"
          />
        </div>
      </div>
    </div>
  );
};

// Grid Card Component - using DataCard primitive
const KnowledgeCard = ({ item }: { item: (typeof MOCK_KNOWLEDGE_ITEMS)[0] }) => {
  const isUrl = !!item.url;
  const isTechnical = item.type === "technical";

  const getEdgeColor = (): "cyan" | "purple" | "blue" | "pink" => {
    if (isTechnical) return isUrl ? "cyan" : "purple";
    return isUrl ? "blue" : "pink";
  };

  return (
    <DataCard
      edgePosition="top"
      edgeColor={getEdgeColor()}
      blur="md"
      className="cursor-pointer hover:shadow-[0_0_30px_rgba(6,182,212,0.2)] transition-shadow"
    >
      <DataCardHeader>
        <div className="flex items-center gap-2 mb-3">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium",
              isUrl
                ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-400"
                : "bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400",
            )}
          >
            {isUrl ? <Globe className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
            <span>{isUrl ? "Web Page" : "Document"}</span>
          </div>
          <span
            className={cn(
              "px-2 py-1 text-xs rounded-md font-medium",
              item.type === "technical"
                ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
                : "bg-purple-500/10 text-purple-600 dark:text-purple-400",
            )}
          >
            {item.type}
          </span>
        </div>

        <h4 className="font-medium text-gray-900 dark:text-white mb-2 line-clamp-2">{item.title}</h4>

        {item.url && <div className="text-xs text-gray-600 dark:text-gray-400 truncate">{item.url}</div>}
      </DataCardHeader>

      <DataCardContent />

      <DataCardFooter>
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
            <Calendar className="w-3 h-3" />
            <span>{item.date}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatPill
              color="orange"
              value={item.chunks}
              icon={<FileText className="w-3.5 h-3.5" />}
              size="sm"
              onClick={() => console.log("View documents")}
              className="cursor-pointer hover:scale-105 transition-transform"
            />
            <StatPill
              color="blue"
              value={item.codeExamples}
              icon={<Code className="w-3.5 h-3.5" />}
              size="sm"
              onClick={() => console.log("View code examples")}
              className="cursor-pointer hover:scale-105 transition-transform"
            />
          </div>
        </div>
      </DataCardFooter>
    </DataCard>
  );
};

// Table Row Component - matching TaskView standard pattern
const KnowledgeTableRow = ({ item, index }: { item: (typeof MOCK_KNOWLEDGE_ITEMS)[0]; index: number }) => {
  return (
    <tr
      className={cn(
        "group transition-all duration-200 cursor-pointer",
        index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
        "hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20",
        "border-b border-gray-200 dark:border-gray-800",
      )}
    >
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          {item.url ? (
            <Globe className="w-4 h-4 text-cyan-500 flex-shrink-0" />
          ) : (
            <FileText className="w-4 h-4 text-purple-500 flex-shrink-0" />
          )}
          <span className="font-medium text-sm text-gray-900 dark:text-white">{item.title}</span>
        </div>
      </td>
      <td className="px-4 py-2">
        <span
          className={cn(
            "px-2 py-1 text-xs rounded-md font-medium inline-block",
            item.type === "technical"
              ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
              : "bg-purple-500/10 text-purple-600 dark:text-purple-400",
          )}
        >
          {item.type}
        </span>
      </td>
      <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 max-w-xs truncate">
        {item.url || "Uploaded Document"}
      </td>
      <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">{item.chunks}</td>
      <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">{item.date}</td>
    </tr>
  );
};
