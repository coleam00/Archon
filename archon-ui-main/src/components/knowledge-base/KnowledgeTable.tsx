import React, { useState } from "react";
import {
  KnowledgeItem,
  KnowledgeItemMetadata,
} from "../../services/knowledgeBaseService";
import { Badge } from "../ui/Badge";
import {
  Link as LinkIcon,
  Upload,
  Trash2,
  RefreshCw,
  X,
  Globe,
  BoxIcon,
  Brain,
} from "lucide-react";
import { format } from "date-fns";

// Reuse the same grouping logic from KnowledgeBasePage
const extractDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Remove 'www.' prefix if present
    const withoutWww = hostname.startsWith("www.")
      ? hostname.slice(4)
      : hostname;

    // For domains with subdomains, extract the main domain (last 2 parts)
    const parts = withoutWww.split(".");
    if (parts.length > 2) {
      // Return the main domain (last 2 parts: domain.tld)
      return parts.slice(-2).join(".");
    }

    return withoutWww;
  } catch {
    return url; // Return original if URL parsing fails
  }
};

interface GroupedKnowledgeItem {
  id: string;
  title: string;
  domain: string;
  items: KnowledgeItem[];
  metadata: KnowledgeItemMetadata;
  created_at: string;
  updated_at: string;
}

const groupItemsByDomain = (items: KnowledgeItem[]): GroupedKnowledgeItem[] => {
  const groups = new Map<string, KnowledgeItem[]>();

  // Group items by domain
  items.forEach((item) => {
    // Only group URL-based items, not file uploads
    if (item.metadata.source_type === "url") {
      const domain = extractDomain(item.url);
      const existing = groups.get(domain) || [];
      groups.set(domain, [...existing, item]);
    } else {
      // File uploads remain ungrouped
      groups.set(`file_${item.id}`, [item]);
    }
  });

  // Convert groups to GroupedKnowledgeItem objects
  return Array.from(groups.entries()).map(([domain, groupItems]) => {
    const firstItem = groupItems[0];
    const isFileGroup = domain.startsWith("file_");

    // Find the latest update timestamp and convert it properly to ISO string
    const timestamps = groupItems
      .map((i) => Date.parse(i.updated_at))
      .filter((t) => Number.isFinite(t));
    const latestTimestamp = timestamps.length ? Math.max(...timestamps) : undefined;

    return {
      id: isFileGroup ? firstItem.id : `group_${domain}`,
      title: isFileGroup ? firstItem.title : `${domain}`,
      domain: isFileGroup ? "file" : domain,
      items: groupItems,
      metadata: {
        ...firstItem.metadata,
        // Merge tags from all items in the group
        tags: [
          ...new Set(groupItems.flatMap((item) => item.metadata.tags || [])),
        ],
        // Sum up chunks count for grouped items
        chunks_count: groupItems.reduce(
          (sum, item) => sum + (item.metadata.chunks_count || 0),
          0
        ),
      },
      created_at: firstItem.created_at,
      updated_at: latestTimestamp
        ? new Date(latestTimestamp).toISOString()
        : firstItem.updated_at,
    };
  });
};

interface KnowledgeTableProps {
  items: KnowledgeItem[];
  onDelete: (sourceId: string) => void;
}

export const KnowledgeTable: React.FC<KnowledgeTableProps> = ({
  items,
  onDelete,
}) => {
  const statusColorMap = {
    active: "green",
    processing: "blue",
    error: "pink",
  };

  // Group items by domain
  const groupedItems = groupItemsByDomain(items);

  // Get frequency display - based on update_frequency days
  const getFrequencyDisplay = (frequency?: number) => {
    if (!frequency || frequency === 0) {
      return {
        icon: <X className="w-3 h-3" />,
        text: "Never",
        color: "text-gray-500 dark:text-zinc-500",
      };
    } else if (frequency === 1) {
      return {
        icon: <RefreshCw className="w-3 h-3" />,
        text: "Daily",
        color: "text-green-500",
      };
    } else if (frequency === 7) {
      return {
        icon: <RefreshCw className="w-3 h-3" />,
        text: "Weekly",
        color: "text-blue-500",
      };
    } else if (frequency === 30) {
      return {
        icon: <RefreshCw className="w-3 h-3" />,
        text: "Monthly",
        color: "text-purple-500",
      };
    } else {
      return {
        icon: <RefreshCw className="w-3 h-3" />,
        text: `Every ${frequency} days`,
        color: "text-gray-500 dark:text-zinc-500",
      };
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
        <thead className="bg-gray-50 dark:bg-zinc-900/50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Title
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Tags
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Sources
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Words
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Updated
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Frequency
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
              Status
            </th>
            <th className="relative px-6 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-zinc-900 divide-y divide-gray-200 dark:divide-zinc-700">
          {groupedItems.map((groupedItem) => (
            <GroupedKnowledgeTableRow
              key={groupedItem.id}
              groupedItem={groupedItem}
              onDelete={onDelete}
              statusColorMap={statusColorMap}
              getFrequencyDisplay={getFrequencyDisplay}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

interface GroupedKnowledgeTableRowProps {
  groupedItem: GroupedKnowledgeItem;
  onDelete: (sourceId: string) => void;
  statusColorMap: Record<string, string>;
  getFrequencyDisplay: (frequency?: number) => {
    icon: React.ReactNode;
    text: string;
    color: string;
  };
}

const GroupedKnowledgeTableRow: React.FC<GroupedKnowledgeTableRowProps> = ({
  groupedItem,
  onDelete,
  statusColorMap,
  getFrequencyDisplay,
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [showTagsTooltip, setShowTagsTooltip] = useState(false);

  const isGrouped = groupedItem.items.length > 1;
  const firstItem = groupedItem.items[0];
  const frequencyDisplay = getFrequencyDisplay(
    firstItem.metadata.update_frequency
  );

  // Get the type icon
  const TypeIcon =
    firstItem.metadata.knowledge_type === "technical" ? BoxIcon : Brain;
  // const typeIconColor = firstItem.metadata.knowledge_type === 'technical' ? 'text-blue-500' : 'text-purple-500';

  // Generate tooltip content for grouped items
  // const tooltipContent = isGrouped ? (
  //   <div className="space-y-1">
  //     <div className="font-medium text-white">Grouped Sources:</div>
  //     {groupedItem.items.map((item, index) => (
  //       <div key={item.id} className="text-sm text-gray-200">
  //         {index + 1}. {item.source_id}
  //       </div>
  //     ))}
  //   </div>
  // ) : null;

  const handleDelete = async () => {
    if (isGrouped) {
      // Delete all items in the group
      for (const item of groupedItem.items) {
        await onDelete(item.source_id);
      }
    } else {
      await onDelete(firstItem.source_id);
    }
  };

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-zinc-800/50">
      <td className="px-6 py-4 max-w-xs">
        <div className="flex items-center gap-2">
          {firstItem.metadata.source_type === "url" ? (
            <LinkIcon
              className={`w-4 h-4 flex-shrink-0 ${
                firstItem.metadata.knowledge_type === "technical"
                  ? "text-blue-500"
                  : "text-cyan-500"
              }`}
            />
          ) : (
            <Upload
              className={`w-4 h-4 flex-shrink-0 ${
                firstItem.metadata.knowledge_type === "technical"
                  ? "text-purple-500"
                  : "text-pink-500"
              }`}
            />
          )}
          <TypeIcon
            className={`w-4 h-4 flex-shrink-0 ${
              firstItem.metadata.source_type === "url"
                ? firstItem.metadata.knowledge_type === "technical"
                  ? "text-blue-500"
                  : "text-cyan-500"
                : firstItem.metadata.knowledge_type === "technical"
                ? "text-purple-500"
                : "text-pink-500"
            }`}
          />
          <div
            className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[200px]"
            title={isGrouped ? groupedItem.domain : firstItem.title}
          >
            {isGrouped ? groupedItem.domain : firstItem.title}
          </div>
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
        <Badge
          color={
            firstItem.metadata.knowledge_type === "technical" ? "blue" : "pink"
          }
        >
          {firstItem.metadata.knowledge_type}
        </Badge>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="relative">
          <div
            className="flex flex-wrap gap-1"
            onMouseEnter={() =>
              (groupedItem.metadata.tags?.length || 0) > 3 &&
              setShowTagsTooltip(true)
            }
            onMouseLeave={() => setShowTagsTooltip(false)}
          >
            {groupedItem.metadata.tags?.slice(0, 3).map((tag) => (
              <Badge key={tag} color="purple" variant="outline">
                {tag}
              </Badge>
            ))}
            {(groupedItem.metadata.tags?.length || 0) > 3 && (
              <Badge color="gray" variant="outline" className="cursor-pointer">
                +{(groupedItem.metadata.tags?.length || 0) - 3}
              </Badge>
            )}
          </div>

          {/* Tags Tooltip */}
          {showTagsTooltip && (groupedItem.metadata.tags?.length || 0) > 3 && (
            <div className="absolute bottom-full mb-2 left-0 bg-black dark:bg-zinc-800 text-white text-xs rounded-lg py-2 px-3 shadow-lg z-50 max-w-xs">
              <div className="font-semibold text-purple-300 mb-1">
                All Tags:
              </div>
              <div className="flex flex-wrap gap-1">
                {groupedItem.metadata.tags?.map((tag, index) => (
                  <span
                    key={index}
                    className="bg-purple-500/20 text-purple-300 px-2 py-1 rounded text-xs"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="absolute top-full left-4 border-4 border-transparent border-t-black dark:border-t-zinc-800"></div>
            </div>
          )}
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        {isGrouped ? (
          <div
            className="cursor-pointer relative inline-block"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <div className="flex items-center gap-1 px-2 py-1 bg-blue-500/20 border border-blue-500/40 rounded-full backdrop-blur-sm shadow-[0_0_15px_rgba(59,130,246,0.3)] hover:shadow-[0_0_20px_rgba(59,130,246,0.5)] transition-all duration-300">
              <Globe className="w-3 h-3 text-blue-400" />
              <span className="text-xs text-blue-400 font-medium">
                {groupedItem.items.length}
              </span>
            </div>

            {/* Tooltip */}
            {showTooltip && (
              <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 bg-black dark:bg-zinc-800 text-white text-xs rounded-lg py-2 px-3 shadow-lg z-50 whitespace-nowrap max-w-xs">
                <div className="font-semibold text-blue-300 mb-1">
                  Grouped Sources:
                </div>
                {groupedItem.items.map((item, index) => (
                  <div key={index} className="text-gray-300">
                    {index + 1}. {item.source_id}
                  </div>
                ))}
                <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-black dark:border-t-zinc-800"></div>
              </div>
            )}
          </div>
        ) : (
          <span className="text-sm text-gray-500 dark:text-zinc-400">1</span>
        )}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
        {groupedItem.metadata.chunks_count || 0}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-zinc-400">
        {(() => {
          try {
            const date = new Date(groupedItem.updated_at);
            return isNaN(date.getTime())
              ? "Invalid date"
              : format(date, "MMM dd, yyyy");
          } catch (error) {
            return "Invalid date";
          }
        })()}
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <div className={`flex items-center gap-1 ${frequencyDisplay.color}`}>
          {frequencyDisplay.icon}
          <span className="text-sm">{frequencyDisplay.text}</span>
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <Badge
          color={statusColorMap[firstItem.metadata.status || "active"] as any}
        >
          {(firstItem.metadata.status || "active").charAt(0).toUpperCase() +
            (firstItem.metadata.status || "active").slice(1)}
        </Badge>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
        <div className="flex justify-end gap-2">
          <button
            onClick={handleDelete}
            className="p-2 text-gray-500 hover:text-red-500"
            title={
              isGrouped
                ? `Delete ${groupedItem.items.length} sources`
                : "Delete"
            }
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
};
