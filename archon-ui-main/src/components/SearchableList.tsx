/**
 * SearchableList Component with React 18 Concurrent Features
 * Uses useTransition for non-blocking search updates
 */

import React, { useState, useTransition, useMemo, useCallback } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

export interface SearchableListItem {
  id: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchableListProps<T extends SearchableListItem> {
  items: T[];
  onItemClick?: (item: T) => void;
  onItemSelect?: (item: T) => void;
  renderItem?: (item: T, isHighlighted: boolean) => React.ReactNode;
  searchFields?: (keyof T)[];
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  itemClassName?: string;
  enableMultiSelect?: boolean;
  selectedItems?: T[];
  virtualize?: boolean;
  virtualizeThreshold?: number;
  // Virtualization configuration
  itemHeight?: number; // Height of each item in pixels (default: 80)
  containerHeight?: number; // Height of scrollable container in pixels (default: 600)
}

/**
 * SearchableList with React 18 concurrent features
 */
export function SearchableList<T extends SearchableListItem>({
  items,
  onItemClick,
  onItemSelect,
  renderItem,
  searchFields = ['title', 'description'] as (keyof T)[],
  placeholder = 'Search...',
  emptyMessage = 'No items found',
  className = '',
  itemClassName = '',
  enableMultiSelect = false,
  selectedItems = [],
  virtualize = true,
  virtualizeThreshold = 100,
  itemHeight = 80,
  containerHeight = 600
}: SearchableListProps<T>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(selectedItems.map(item => item.id))
  );
  
  // Use transition for non-blocking search updates
  const [isPending, startTransition] = useTransition();

  /**
   * Filter items based on search query with transition
   */
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) {
      return items;
    }

    const query = searchQuery.toLowerCase();
    return items.filter(item => {
      return searchFields.some(field => {
        const value = item[field];
        if (typeof value === 'string') {
          return value.toLowerCase().includes(query);
        }
        if (value && typeof value === 'object') {
          return JSON.stringify(value).toLowerCase().includes(query);
        }
        return false;
      });
    });
  }, [items, searchQuery, searchFields]);

  /**
   * Handle search input with transition
   */
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    
    // Use transition for non-urgent update
    startTransition(() => {
      setSearchQuery(value);
    });
  }, []);

  /**
   * Clear search
   */
  const handleClearSearch = useCallback(() => {
    startTransition(() => {
      setSearchQuery('');
    });
  }, []);

  /**
   * Handle item selection
   */
  const handleItemSelect = useCallback((item: T) => {
    if (enableMultiSelect) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
    } else {
      setSelectedIds(new Set([item.id]));
    }
    
    if (onItemSelect) {
      onItemSelect(item);
    }
  }, [enableMultiSelect, onItemSelect]);

  /**
   * Handle item click
   */
  const handleItemClick = useCallback((item: T) => {
    if (onItemClick) {
      onItemClick(item);
    } else {
      handleItemSelect(item);
    }
  }, [onItemClick, handleItemSelect]);

  /**
   * Default item renderer
   */
  const defaultRenderItem = useCallback((item: T, isHighlighted: boolean) => {
    const isSelected = selectedIds.has(item.id);
    
    return (
      <div
        className={`
          p-3 cursor-pointer transition-all duration-150
          ${isHighlighted ? 'bg-blue-50 dark:bg-blue-900/20' : ''}
          ${isSelected ? 'bg-blue-100 dark:bg-blue-900/30 border-l-4 border-blue-500' : ''}
          hover:bg-gray-50 dark:hover:bg-gray-800
          ${itemClassName}
        `}
        onMouseEnter={() => setHighlightedId(item.id)}
        onMouseLeave={() => setHighlightedId(null)}
        onClick={() => handleItemClick(item)}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {item.title}
            </h4>
            {item.description && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {enableMultiSelect && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => handleItemSelect(item)}
              onClick={(e) => e.stopPropagation()}
              className="ml-3 mt-1 h-4 w-4 text-blue-600 rounded focus:ring-blue-500"
            />
          )}
        </div>
      </div>
    );
  }, [selectedIds, itemClassName, handleItemClick, handleItemSelect, enableMultiSelect]);

  /**
   * Virtualized list renderer for large lists
   */
  const [scrollTop, setScrollTop] = useState(0);
  
  const renderVirtualizedList = useCallback(() => {
    // Simple virtualization with configurable dimensions
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.min(startIndex + visibleCount + 1, filteredItems.length);
    const visibleItems = filteredItems.slice(startIndex, endIndex);
    const totalHeight = filteredItems.length * itemHeight;
    const offsetY = startIndex * itemHeight;
    
    return (
      <div
        className="relative overflow-auto"
        style={{ height: containerHeight }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: totalHeight }}>
          <div
            style={{
              transform: `translateY(${offsetY}px)`
            }}
          >
            {visibleItems.map(item => (
              <div key={item.id} style={{ height: itemHeight }}>
                {renderItem ? renderItem(item, highlightedId === item.id) : defaultRenderItem(item, highlightedId === item.id)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }, [filteredItems, highlightedId, renderItem, defaultRenderItem, containerHeight, itemHeight, scrollTop]);

  /**
   * Regular list renderer
   */
  const renderRegularList = useCallback(() => {
    return (
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {filteredItems.map(item => (
          <div key={item.id}>
            {renderItem ? renderItem(item, highlightedId === item.id) : defaultRenderItem(item, highlightedId === item.id)}
          </div>
        ))}
      </div>
    );
  }, [filteredItems, highlightedId, renderItem, defaultRenderItem]);

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Search Bar */}
      <div className="relative mb-4">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={placeholder}
            className={`
              w-full pl-10 pr-10 py-2 
              border border-gray-300 dark:border-gray-600 
              rounded-lg
              bg-white dark:bg-gray-800
              text-gray-900 dark:text-gray-100
              placeholder-gray-500 dark:placeholder-gray-400
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
              transition-all duration-150
              ${isPending ? 'opacity-70' : ''}
            `}
          />
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            {isPending ? (
              <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
            ) : (
              <Search className="h-4 w-4 text-gray-400" />
            )}
          </div>
          {searchQuery && (
            <button
              onClick={handleClearSearch}
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
            >
              <X className="h-4 w-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
            </button>
          )}
        </div>
        {isPending && (
          <div className="absolute top-full left-0 mt-1 text-xs text-gray-500 dark:text-gray-400">
            Searching...
          </div>
        )}
      </div>

      {/* Results Count */}
      {searchQuery && (
        <div className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          {filteredItems.length} result{filteredItems.length !== 1 ? 's' : ''} found
        </div>
      )}

      {/* List Container */}
      <div className="flex-1 overflow-auto">
        {filteredItems.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            {emptyMessage}
          </div>
        ) : (
          <>
            {virtualize && filteredItems.length > virtualizeThreshold
              ? renderVirtualizedList()
              : renderRegularList()
            }
          </>
        )}
      </div>

      {/* Selection Summary */}
      {enableMultiSelect && selectedIds.size > 0 && (
        <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''} selected
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Hook for managing searchable list state
 */
export function useSearchableList<T extends SearchableListItem>(
  items: T[],
  searchFields: (keyof T)[] = ['title', 'description'] as (keyof T)[]
) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isPending, startTransition] = useTransition();

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) {
      return items;
    }

    const query = searchQuery.toLowerCase();
    return items.filter(item => {
      return searchFields.some(field => {
        const value = item[field];
        if (typeof value === 'string') {
          return value.toLowerCase().includes(query);
        }
        return false;
      });
    });
  }, [items, searchQuery, searchFields]);

  const updateSearch = useCallback((query: string) => {
    startTransition(() => {
      setSearchQuery(query);
    });
  }, []);

  const clearSearch = useCallback(() => {
    startTransition(() => {
      setSearchQuery('');
    });
  }, []);

  return {
    searchQuery,
    filteredItems,
    isPending,
    updateSearch,
    clearSearch
  };
}