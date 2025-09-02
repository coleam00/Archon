import { useEffect, useState, useRef, useMemo } from 'react';
import { Search, Grid, Plus, Link as LinkIcon, Brain, Filter, BoxIcon, List, BookOpen, CheckSquare, ChevronDown, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Badge } from '../components/ui/Badge';
import { GlassCrawlDepthSelector } from '../components/ui/GlassCrawlDepthSelector';
import { useStaggeredEntrance } from '../hooks/useStaggeredEntrance';
import { useToast } from '../contexts/ToastContext';
import { knowledgeBaseService, KnowledgeItem, KnowledgeItemMetadata } from '../services/knowledgeBaseService';
import { knowledgeSocketIO } from '../services/socketIOService';
import { CrawlingProgressCard } from '../components/knowledge-base/CrawlingProgressCard';
import { CrawlProgressData, crawlProgressService } from '../services/crawlProgressService';
import { WebSocketState } from '../services/socketIOService';
import { KnowledgeTable } from '../components/knowledge-base/KnowledgeTable';
import { KnowledgeItemCard } from '../components/knowledge-base/KnowledgeItemCard';
import { GroupedKnowledgeItemCard } from '../components/knowledge-base/GroupedKnowledgeItemCard';
import { KnowledgeGridSkeleton, KnowledgeTableSkeleton } from '../components/knowledge-base/KnowledgeItemSkeleton';
import { GroupCreationModal } from '../components/knowledge-base/GroupCreationModal';

const extractDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Remove 'www.' prefix if present
    const withoutWww = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
    
    // For domains with subdomains, extract the main domain (last 2 parts)
    const parts = withoutWww.split('.');
    if (parts.length > 2) {
      // Return the main domain (last 2 parts: domain.tld)
      return parts.slice(-2).join('.');
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



export const KnowledgeBasePage = () => {
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | 'technical' | 'business'>('all');
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [progressItems, setProgressItems] = useState<CrawlProgressData[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  
  // Selection state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  
  
  const { showToast } = useToast();

  // Single consolidated loading function - only loads data, no filtering
  const loadKnowledgeItems = async () => {
    const startTime = Date.now();
    console.log('📊 Loading all knowledge items from API...');
    
    try {
      setLoading(true);
      // Always load ALL items from API, filtering happens client-side
      const response = await knowledgeBaseService.getKnowledgeItems({
        page: currentPage,
        per_page: 100 // Load more items per page since we filter client-side
      });
      
      const loadTime = Date.now() - startTime;
      console.log(`📊 API request completed in ${loadTime}ms, loaded ${response.items.length} items`);
      
      setKnowledgeItems(response.items);
      setTotalItems(response.total);
    } catch (error) {
      console.error('Failed to load knowledge items:', error);
      showToast('Failed to load knowledge items', 'error');
      setKnowledgeItems([]);
    } finally {
      setLoading(false);
    }
  };

  // Initialize knowledge items on mount - load via REST API immediately
  useEffect(() => {
    console.log('🚀 KnowledgeBasePage: Loading knowledge items via REST API');
    
    // Load items immediately via REST API
    loadKnowledgeItems();
    
    return () => {
      console.log('🧹 KnowledgeBasePage: Cleaning up');
      // Cleanup all crawl progress connections on unmount
      crawlProgressService.disconnect();
    };
  }, []); // Only run once on mount

  // Load and reconnect to active crawls from localStorage
  useEffect(() => {
    const loadActiveCrawls = async () => {
      try {
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        const now = Date.now();
        const TWO_MINUTES = 120000; // 2 minutes in milliseconds
        const ONE_HOUR = 3600000; // 1 hour in milliseconds
        const validCrawls: string[] = [];
        
        for (const progressId of activeCrawls) {
          const crawlDataStr = localStorage.getItem(`crawl_progress_${progressId}`);
          if (crawlDataStr) {
            try {
              const crawlData = JSON.parse(crawlDataStr);
              const startedAt = crawlData.startedAt || 0;
              const lastUpdated = crawlData.lastUpdated || startedAt;
              
              // Skip cancelled crawls
              if (crawlData.status === 'cancelled' || crawlData.cancelledAt) {
                localStorage.removeItem(`crawl_progress_${progressId}`);
                continue;
              }
              
              // Check if crawl is not too old (within 1 hour) and not completed/errored
              if (now - startedAt < ONE_HOUR && 
                  crawlData.status !== 'completed' && 
                  crawlData.status !== 'error') {
                
                // Check if crawl is stale (no updates for 2 minutes)
                const isStale = now - lastUpdated > TWO_MINUTES;
                
                if (isStale) {
                  // Mark as stale and allow user to dismiss
                  setProgressItems(prev => [...prev, {
                    ...crawlData,
                    status: 'stale',
                    percentage: crawlData.percentage || 0,
                    logs: [...(crawlData.logs || []), 'Crawl appears to be stuck. You can dismiss this.'],
                    error: 'No updates received for over 2 minutes'
                  }]);
                  validCrawls.push(progressId); // Keep in list but marked as stale
                } else {
                  validCrawls.push(progressId);
                  
                  // Add to progress items with reconnecting status
                  setProgressItems(prev => [...prev, {
                    ...crawlData,
                    status: 'reconnecting',
                    percentage: crawlData.percentage || 0,
                    logs: [...(crawlData.logs || []), 'Reconnecting to crawl...']
                  }]);
                  
                  // Reconnect to Socket.IO room
                  await crawlProgressService.streamProgressEnhanced(progressId, {
                    onMessage: (data: CrawlProgressData) => {
                      console.log('🔄 Reconnected crawl progress update:', data);
                      if (data.status === 'completed') {
                        handleProgressComplete(data);
                      } else if (data.error || data.status === 'error') {
                        handleProgressError(data.error || 'Crawl failed', progressId);
                      } else if (data.status === 'cancelled' || data.status === 'stopped') {
                        // Handle cancelled/stopped status
                        handleProgressUpdate({ ...data, status: 'cancelled' });
                        // Clean up from progress tracking
                        setTimeout(() => {
                          setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
                          // Clean up from localStorage
                          try {
                            localStorage.removeItem(`crawl_progress_${progressId}`);
                            const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
                            const updated = activeCrawls.filter((id: string) => id !== progressId);
                            localStorage.setItem('active_crawls', JSON.stringify(updated));
                          } catch (error) {
                            console.error('Failed to clean up cancelled crawl:', error);
                          }
                          crawlProgressService.stopStreaming(progressId);
                        }, 2000); // Show cancelled status for 2 seconds before removing
                      } else {
                        handleProgressUpdate(data);
                      }
                    },
                    onError: (error: Error | Event) => {
                      const errorMessage = error instanceof Error ? error.message : 'Connection error';
                      console.error('❌ Reconnection error:', errorMessage);
                      handleProgressError(errorMessage, progressId);
                    }
                  }, {
                    autoReconnect: true,
                    reconnectDelay: 5000
                  });
                }
              } else {
                // Remove stale crawl data
                localStorage.removeItem(`crawl_progress_${progressId}`);
              }
            } catch (error) {
              console.error(`Failed to parse crawl data for ${progressId}:`, error);
              localStorage.removeItem(`crawl_progress_${progressId}`);
            }
          }
        }
        
        // Update active crawls list with only valid ones
        if (validCrawls.length !== activeCrawls.length) {
          localStorage.setItem('active_crawls', JSON.stringify(validCrawls));
        }
      } catch (error) {
        console.error('Failed to load active crawls:', error);
      }
    };
    
    loadActiveCrawls();
  }, []); // Only run once on mount


  // Memoized filtered items - filters run client-side
  const filteredItems = useMemo(() => {
    return knowledgeItems.filter(item => {
      // Type filter
      const typeMatch = typeFilter === 'all' || item.metadata.knowledge_type === typeFilter;
      
      // Search filter - search in title, description, tags, and source_id
      const searchLower = searchQuery.toLowerCase();
      const searchMatch = !searchQuery || 
        item.title.toLowerCase().includes(searchLower) ||
        item.metadata.description?.toLowerCase().includes(searchLower) ||
        item.metadata.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ||
        item.source_id.toLowerCase().includes(searchLower);
      
      return typeMatch && searchMatch;
    });
  }, [knowledgeItems, typeFilter, searchQuery]);

  // Memoized grouped items
  const groupedItems = useMemo(() => {
    if (viewMode !== 'grid') return [];
    
    return filteredItems
      .filter(item => item.metadata?.group_name)
      .reduce((groups: GroupedKnowledgeItem[], item) => {
        const groupName = item.metadata.group_name!;
        const existingGroup = groups.find(g => g.title === groupName);
        
        if (existingGroup) {
          existingGroup.items.push(item);
        } else {
          groups.push({
            id: `group_${groupName.replace(/\s+/g, '_')}`,
            title: groupName,
            domain: groupName, // For compatibility
            items: [item],
            metadata: {
              ...item.metadata,
              source_type: 'group',
              chunks_count: item.metadata.chunks_count || 0,
              word_count: item.metadata.word_count || 0,
            },
            created_at: item.created_at,
            updated_at: item.updated_at,
          });
        }
        
        return groups;
      }, []);
  }, [filteredItems, viewMode]);
  
  // Memoized ungrouped items
  const ungroupedItems = useMemo(() => {
    return viewMode === 'grid' ? filteredItems.filter(item => !item.metadata?.group_name) : [];
  }, [filteredItems, viewMode]);

  // Use our custom staggered entrance hook for the page header
  const {
    containerVariants: headerContainerVariants,
    itemVariants: headerItemVariants,
    titleVariants
  } = useStaggeredEntrance([1, 2], 0.15);

  // Separate staggered entrance for the content that will reanimate on view changes
  const {
    containerVariants: contentContainerVariants,
    itemVariants: contentItemVariants
  } = useStaggeredEntrance(filteredItems, 0.15);

  const handleAddKnowledge = () => {
    setIsAddModalOpen(true);
  };

  
  // Selection handlers
  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    if (isSelectionMode) {
      // Exiting selection mode - clear selections
      setSelectedItems(new Set());
      setLastSelectedIndex(null);
    }
  };
  
  const toggleItemSelection = (itemId: string, index: number, event: React.MouseEvent) => {
    const newSelected = new Set(selectedItems);
    
    if (event.shiftKey && lastSelectedIndex !== null) {
      // Shift-click: select range
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      // Get items in range
      for (let i = start; i <= end; i++) {
        if (filteredItems[i]) {
          newSelected.add(filteredItems[i].id);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd-click: toggle single item
      if (newSelected.has(itemId)) {
        newSelected.delete(itemId);
      } else {
        newSelected.add(itemId);
      }
    } else {
      // Regular click in selection mode: toggle single item
      if (newSelected.has(itemId)) {
        newSelected.delete(itemId);
      } else {
        newSelected.add(itemId);
      }
    }
    
    setSelectedItems(newSelected);
    setLastSelectedIndex(index);
  };
  
  const selectAll = () => {
    const allIds = new Set(filteredItems.map(item => item.id));
    setSelectedItems(allIds);
  };
  
  const deselectAll = () => {
    setSelectedItems(new Set());
    setLastSelectedIndex(null);
  };
  
  const deleteSelectedItems = async () => {
    if (selectedItems.size === 0) return;
    
    const count = selectedItems.size;
    const confirmed = window.confirm(`Are you sure you want to delete ${count} selected item${count > 1 ? 's' : ''}?`);
    
    if (!confirmed) return;
    
    try {
      // Delete each selected item
      const deletePromises = Array.from(selectedItems).map(itemId => 
        knowledgeBaseService.deleteKnowledgeItem(itemId)
      );
      
      await Promise.all(deletePromises);
      
      // Remove deleted items from state
      setKnowledgeItems(prev => prev.filter(item => !selectedItems.has(item.id)));
      
      // Clear selection
      setSelectedItems(new Set());
      setIsSelectionMode(false);
      
      showToast(`Successfully deleted ${count} item${count > 1 ? 's' : ''}`, 'success');
    } catch (error) {
      console.error('Failed to delete selected items:', error);
      showToast('Failed to delete some items', 'error');
    }
  };
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + A: Select all (only in selection mode)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && isSelectionMode) {
        e.preventDefault();
        selectAll();
      }
      
      // Escape: Exit selection mode
      if (e.key === 'Escape' && isSelectionMode) {
        toggleSelectionMode();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectionMode, filteredItems]);

  const handleRefreshItem = async (sourceId: string) => {
    try {
      console.log('🔄 Refreshing knowledge item:', sourceId);
      
      // Get the item being refreshed to show its URL in progress
      const item = knowledgeItems.find(k => k.source_id === sourceId);
      if (!item) return;
      
      // Call the refresh API
      const response = await knowledgeBaseService.refreshKnowledgeItem(sourceId);
      console.log('🔄 Refresh response:', response);
      
      if (response.progressId) {
        // Add progress tracking
        const progressData: CrawlProgressData = {
          progressId: response.progressId,
          currentUrl: item.url,
          totalPages: 0,
          processedPages: 0,
          percentage: 0,
          status: 'starting',
          message: 'Starting refresh...',
          logs: ['Starting refresh for ' + item.url],
          crawlType: 'refresh',
          currentStep: 'starting',
          startTime: new Date()
        };
        
        setProgressItems(prev => [...prev, progressData]);
        
        // Store in localStorage for persistence
        try {
          localStorage.setItem(`crawl_progress_${response.progressId}`, JSON.stringify({
            ...progressData,
            startedAt: Date.now()
          }));
          
          const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
          if (!activeCrawls.includes(response.progressId)) {
            activeCrawls.push(response.progressId);
            localStorage.setItem('active_crawls', JSON.stringify(activeCrawls));
          }
        } catch (error) {
          console.error('Failed to persist refresh progress:', error);
        }
        
        // Remove the item temporarily while it's being refreshed
        setKnowledgeItems(prev => prev.filter(k => k.source_id !== sourceId));
        
        // Connect to crawl progress WebSocket
        await crawlProgressService.streamProgressEnhanced(response.progressId, {
          onMessage: (data: CrawlProgressData) => {
            console.log('🔄 Refresh progress update:', data);
            if (data.status === 'completed') {
              handleProgressComplete(data);
            } else if (data.error || data.status === 'error') {
              handleProgressError(data.error || 'Refresh failed', response.progressId);
            } else if (data.status === 'cancelled' || data.status === 'stopped') {
              // Handle cancelled/stopped status
              handleProgressUpdate({ ...data, status: 'cancelled' });
              setTimeout(() => {
                setProgressItems(prev => prev.filter(item => item.progressId !== response.progressId));
                // Clean up from localStorage
                try {
                  localStorage.removeItem(`crawl_progress_${response.progressId}`);
                  const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
                  const updated = activeCrawls.filter((id: string) => id !== response.progressId);
                  localStorage.setItem('active_crawls', JSON.stringify(updated));
                } catch (error) {
                  console.error('Failed to clean up cancelled crawl:', error);
                }
                crawlProgressService.stopStreaming(response.progressId);
              }, 2000); // Show cancelled status for 2 seconds before removing
            } else {
              handleProgressUpdate(data);
            }
          },
          onStateChange: (state: any) => {
            console.log('🔄 Refresh state change:', state);
          },
          onError: (error: Error | Event) => {
            const errorMessage = error instanceof Error ? error.message : 'Connection error';
            console.error('❌ Refresh error:', errorMessage);
            handleProgressError(errorMessage, response.progressId);
          }
        }, {
          autoReconnect: true,
          reconnectDelay: 5000,
          connectionTimeout: 10000
        });
      }
    } catch (error) {
      console.error('Failed to refresh knowledge item:', error);
      showToast('Failed to refresh knowledge item', 'error');
    }
  };

  const handleDeleteItem = async (sourceId: string) => {
    try {
      
      // Check if this is a grouped item ID
      if (sourceId.startsWith('group_')) {
        // Find the grouped item and delete all its constituent items
        const groupName = sourceId.replace('group_', '').replace(/_/g, ' ');
        const group = groupedItems.find(g => g.title === groupName);
        
        if (group) {
          // Delete all items in the group
          const deletedIds: string[] = [];
          for (const item of group.items) {
            await knowledgeBaseService.deleteKnowledgeItem(item.source_id);
            deletedIds.push(item.source_id);
          }
          
          // Remove deleted items from state
          setKnowledgeItems(prev => prev.filter(item => !deletedIds.includes(item.source_id)));
          
          showToast(`Deleted ${group.items.length} items from group "${groupName}"`, 'success');
        }
      } else {
        // Single item delete
        const result = await knowledgeBaseService.deleteKnowledgeItem(sourceId);
        
        // Remove the deleted item from state
        setKnowledgeItems(prev => prev.filter(item => item.source_id !== sourceId));
        
        showToast((result as any).message || 'Item deleted', 'success');
      }
    } catch (error) {
      console.error('Failed to delete item:', error);
      showToast('Failed to delete item', 'error');
    }
  };

  // Progress handling functions
  const handleProgressComplete = (data: CrawlProgressData) => {
    console.log('Crawl completed:', data);
    
    // Update the progress item to show completed state first
    setProgressItems(prev => 
      prev.map(item => 
        item.progressId === data.progressId 
          ? { ...data, status: 'completed', percentage: 100 }
          : item
      )
    );
    
    // Clean up from localStorage immediately
    try {
      localStorage.removeItem(`crawl_progress_${data.progressId}`);
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updated = activeCrawls.filter((id: string) => id !== data.progressId);
      localStorage.setItem('active_crawls', JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to clean up completed crawl:', error);
    }
    
    // Stop the Socket.IO streaming for this progress
    crawlProgressService.stopStreaming(data.progressId);
    
    // Show success toast
    const message = `Crawling completed for ${data.currentUrl}!`;
    showToast(message, 'success');
    
    // Remove from progress items after a brief delay to show completion
    setTimeout(() => {
      setProgressItems(prev => prev.filter(item => item.progressId !== data.progressId));
      // Reload knowledge items to show the new item
      loadKnowledgeItems();
    }, 3000); // 3 second delay to show completion state
  };

  const handleProgressError = (error: string, progressId?: string) => {
    console.error('Crawl error:', error);
    showToast(`Crawling failed: ${error}`, 'error');
    
    // Clean up from localStorage
    if (progressId) {
      try {
        localStorage.removeItem(`crawl_progress_${progressId}`);
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        const updated = activeCrawls.filter((id: string) => id !== progressId);
        localStorage.setItem('active_crawls', JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to clean up failed crawl:', error);
      }
      
      // Stop the Socket.IO streaming for this progress
      crawlProgressService.stopStreaming(progressId);
      
      // Auto-remove failed progress items after 5 seconds to prevent UI clutter
      setTimeout(() => {
        setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
      }, 5000);
    }
  };

  const handleProgressUpdate = (data: CrawlProgressData) => {
    setProgressItems(prev => 
      prev.map(item => 
        item.progressId === data.progressId ? data : item
      )
    );
    
    // Update in localStorage to keep it in sync
    try {
      const existingData = localStorage.getItem(`crawl_progress_${data.progressId}`);
      if (existingData) {
        const parsed = JSON.parse(existingData);
        localStorage.setItem(`crawl_progress_${data.progressId}`, JSON.stringify({
          ...parsed,
          ...data,
          startedAt: parsed.startedAt, // Preserve original start time
          lastUpdated: Date.now() // Track last update time
        }));
      }
    } catch (error) {
      console.error('Failed to update crawl progress in localStorage:', error);
    }
  };

  const handleRetryProgress = async (progressId: string) => {
    // Find the progress item and restart the crawl
    const progressItem = progressItems.find(item => item.progressId === progressId);
    if (!progressItem) {
      showToast('Progress item not found', 'error');
      return;
    }

    // Check if we have original crawl parameters or URL to retry
    if (!progressItem.originalCrawlParams && !progressItem.currentUrl) {
      showToast('Cannot retry: no URL or parameters found. Please start a new crawl manually.', 'warning');
      return;
    }

    try {
      // Remove the failed progress item
      setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
      
      // Clean up from localStorage
      try {
        localStorage.removeItem(`crawl_progress_${progressId}`);
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        const updated = activeCrawls.filter((id: string) => id !== progressId);
        localStorage.setItem('active_crawls', JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to clean up old progress:', error);
      }

      if (progressItem.originalCrawlParams) {
        // Retry crawl
        showToast('Retrying crawl...', 'info');
        
        const result = await knowledgeBaseService.crawlUrl(progressItem.originalCrawlParams);
        
        if ((result as any).progressId) {
          // Start progress tracking with original parameters preserved
          await handleStartCrawl((result as any).progressId, {
            currentUrl: progressItem.originalCrawlParams.url,
            totalPages: 0,
            processedPages: 0,
            uploadType: 'crawl',
            originalCrawlParams: progressItem.originalCrawlParams
          });
          
          showToast('Crawl restarted successfully', 'success');
        } else {
          showToast('Crawl completed immediately', 'success');
          loadKnowledgeItems();
        }
      } else if (progressItem.currentUrl && !progressItem.currentUrl.startsWith('file://')) {
        // Fallback: retry with currentUrl using default parameters
        showToast('Retrying with basic parameters...', 'info');
        
        const fallbackParams = {
          url: progressItem.currentUrl,
          knowledge_type: 'technical' as const,
          tags: [],
          max_depth: 2
        };
        
        const result = await knowledgeBaseService.crawlUrl(fallbackParams);
        
        if ((result as any).progressId) {
          // Start progress tracking with fallback parameters
          await handleStartCrawl((result as any).progressId, {
            currentUrl: progressItem.currentUrl,
            totalPages: 0,
            processedPages: 0,
            uploadType: 'crawl',
            originalCrawlParams: fallbackParams
          });
          
          showToast('Crawl restarted with default settings', 'success');
        } else {
          showToast('Crawl completed immediately', 'success');
          loadKnowledgeItems();
        }
      }
    } catch (error) {
      console.error('Failed to retry:', error);
      showToast(`Retry failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const handleStopCrawl = async (progressId: string) => {
    try {
      // Mark as cancelled in localStorage immediately
      const crawlDataStr = localStorage.getItem(`crawl_progress_${progressId}`);
      if (crawlDataStr) {
        const crawlData = JSON.parse(crawlDataStr);
        crawlData.status = 'cancelled';
        crawlData.cancelledAt = Date.now();
        localStorage.setItem(`crawl_progress_${progressId}`, JSON.stringify(crawlData));
      }
      
      // Call stop endpoint
      await knowledgeBaseService.stopCrawl(progressId);
      
      // Update UI state
      setProgressItems(prev => prev.map(item => 
        item.progressId === progressId 
          ? { ...item, status: 'cancelled', percentage: -1 }
          : item
      ));
      
      // Clean up from active crawls
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updated = activeCrawls.filter((id: string) => id !== progressId);
      localStorage.setItem('active_crawls', JSON.stringify(updated));
      
    } catch (error) {
      console.error('Failed to stop crawl:', error);
      showToast('Failed to stop crawl', 'error');
    }
  };

  const handleStopProgress = (progressId: string) => {
    // This is called from CrawlingProgressCard
    handleStopCrawl(progressId);
  };

  const handleStartCrawl = async (progressId: string, initialData: Partial<CrawlProgressData>) => {
    // handleStartCrawl called with progressId
    // Initial data received
    
    const newProgressItem: CrawlProgressData = {
      progressId,
      status: 'starting',
      percentage: 0,
      logs: ['Starting crawl...'],
      ...initialData
    };
    
    // Adding progress item to state
    setProgressItems(prev => [...prev, newProgressItem]);
    
    // Store in localStorage for persistence
    try {
      // Store the crawl data
      localStorage.setItem(`crawl_progress_${progressId}`, JSON.stringify({
        ...newProgressItem,
        startedAt: Date.now(),
        lastUpdated: Date.now()
      }));
      
      // Add to active crawls list
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      if (!activeCrawls.includes(progressId)) {
        activeCrawls.push(progressId);
        localStorage.setItem('active_crawls', JSON.stringify(activeCrawls));
      }
    } catch (error) {
      console.error('Failed to persist crawl progress:', error);
    }
    
    // Set up callbacks for enhanced progress tracking
    const progressCallback = (data: CrawlProgressData) => {
      // Progress callback called
      
      if (data.progressId === progressId) {
        // Update progress first
        handleProgressUpdate(data);
        
        // Then handle completion/error states
        if (data.status === 'completed') {
          handleProgressComplete(data);
        } else if (data.status === 'error') {
          handleProgressError(data.error || 'Crawling failed', progressId);
        } else if (data.status === 'cancelled' || data.status === 'stopped') {
          // Handle cancelled/stopped status
          handleProgressUpdate({ ...data, status: 'cancelled' });
          setTimeout(() => {
            setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
            // Clean up from localStorage
            try {
              localStorage.removeItem(`crawl_progress_${progressId}`);
              const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
              const updated = activeCrawls.filter((id: string) => id !== progressId);
              localStorage.setItem('active_crawls', JSON.stringify(updated));
            } catch (error) {
              console.error('Failed to clean up cancelled crawl:', error);
            }
            crawlProgressService.stopStreaming(progressId);
          }, 2000); // Show cancelled status for 2 seconds before removing
        }
      }
    };
    
    const stateChangeCallback = (state: WebSocketState) => {
      // WebSocket state changed
      
      // Update UI based on connection state if needed
      if (state === WebSocketState.FAILED) {
        handleProgressError('Connection failed - please check your network', progressId);
      }
    };
    
    const errorCallback = (error: Error | Event) => {
      // WebSocket error
      const errorMessage = error instanceof Error ? error.message : 'Connection error';
      handleProgressError(`Connection error: ${errorMessage}`, progressId);
    };
    
    // Starting progress stream
    
    try {
      // Use the enhanced streamProgress method with all callbacks
      await crawlProgressService.streamProgressEnhanced(progressId, {
        onMessage: progressCallback,
        onStateChange: stateChangeCallback,
        onError: errorCallback
      }, {
        autoReconnect: true,
        reconnectDelay: 5000,
        connectionTimeout: 10000
      });
      
      // WebSocket connected successfully
      
      // Wait for connection to be fully established
      await crawlProgressService.waitForConnection(5000);
      
      // Connection verified
    } catch (error) {
      // Failed to establish WebSocket connection
      handleProgressError('Failed to connect to progress updates', progressId);
    }
  };

  return <div>
      {/* Header with animation - stays static when changing views */}
      <motion.div className="flex justify-between items-center mb-8" initial="hidden" animate="visible" variants={headerContainerVariants}>
        <motion.h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3" variants={titleVariants}>
          <BookOpen className="w-7 h-7 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]" />
          Knowledge Base
        </motion.h1>
        <motion.div className="flex items-center gap-4" variants={headerItemVariants}>
          {/* Search Bar */}
          <div className="relative">
            <Input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search knowledge base..." accentColor="purple" icon={<Search className="w-4 h-4" />} />
          </div>
          {/* Type Filter */}
          <div className="flex items-center bg-gray-50 dark:bg-black border border-gray-200 dark:border-zinc-900 rounded-md overflow-hidden">
            <button onClick={() => setTypeFilter('all')} className={`p-2 ${typeFilter === 'all' ? 'bg-gray-200 dark:bg-zinc-800 text-gray-800 dark:text-white' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} title="All Types">
              <Filter className="w-4 h-4" />
            </button>
            <button onClick={() => setTypeFilter('technical')} className={`p-2 ${typeFilter === 'technical' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} title="Technical/Coding">
              <BoxIcon className="w-4 h-4" />
            </button>
            <button onClick={() => setTypeFilter('business')} className={`p-2 ${typeFilter === 'business' ? 'bg-pink-100 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} title="Business/Project">
              <Brain className="w-4 h-4" />
            </button>
          </div>
          {/* View Toggle */}
          <div className="flex items-center bg-gray-50 dark:bg-black border border-gray-200 dark:border-zinc-900 rounded-md overflow-hidden">
            <button onClick={() => setViewMode('grid')} className={`p-2 ${viewMode === 'grid' ? 'bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-500' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} title="Grid View">
              <Grid className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode('table')} className={`p-2 ${viewMode === 'table' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-500' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} title="Table View">
              <List className="w-4 h-4" />
            </button>
          </div>
          {/* Selection Mode Toggle */}
          <Button 
            onClick={toggleSelectionMode} 
            variant={isSelectionMode ? "secondary" : "ghost"} 
            accentColor="blue"
            className={isSelectionMode ? "bg-blue-500/10 border-blue-500/40" : ""}
          >
            <CheckSquare className="w-4 h-4 mr-2 inline" />
            <span>{isSelectionMode ? 'Cancel' : 'Select'}</span>
          </Button>
          {/* Add Button */}
          <Button onClick={handleAddKnowledge} variant="primary" accentColor="purple" className="shadow-lg shadow-purple-500/20">
            <Plus className="w-4 h-4 mr-2 inline" />
            <span>Knowledge</span>
          </Button>
        </motion.div>
      </motion.div>
      {/* Selection Toolbar - appears when items are selected */}
      <AnimatePresence>
        {isSelectionMode && selectedItems.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mb-6"
          >
            <Card className="p-4 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {selectedItems.size} item{selectedItems.size > 1 ? 's' : ''} selected
                  </span>
                  <Button
                    onClick={selectAll}
                    variant="ghost"
                    size="sm"
                    accentColor="blue"
                  >
                    Select All
                  </Button>
                  <Button
                    onClick={deselectAll}
                    variant="ghost"
                    size="sm"
                    accentColor="gray"
                  >
                    Clear Selection
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => setIsGroupModalOpen(true)}
                    variant="secondary"
                    size="sm"
                    accentColor="blue"
                  >
                    Create Group
                  </Button>
                  <Button
                    onClick={deleteSelectedItems}
                    variant="secondary"
                    size="sm"
                    accentColor="pink"
                  >
                    Delete Selected
                  </Button>
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Main Content */}
      <div className="relative">
        {loading ? (
          viewMode === 'grid' ? <KnowledgeGridSkeleton /> : <KnowledgeTableSkeleton />
        ) : viewMode === 'table' ? (
          <KnowledgeTable 
            items={filteredItems} 
            onDelete={handleDeleteItem} 
          />
        ) : (
          <>
            {/* Knowledge Items Grid/List with staggered animation that reanimates on view change */}
            <AnimatePresence mode="wait">
              <motion.div key={`view-${viewMode}-filter-${typeFilter}`} initial="hidden" animate="visible" variants={contentContainerVariants}>
                {progressItems.length > 0 && viewMode === 'grid' ? (
                  // Two-column layout when there are progress items in grid view
                  <div className="flex gap-4">
                    {/* Left column for progress items */}
                    <div className="w-full lg:w-96 flex-shrink-0 space-y-4">
                      {progressItems.map(progressData => (
                        <motion.div key={progressData.progressId} variants={contentItemVariants}>
                          <CrawlingProgressCard 
                            progressData={progressData}
                            onComplete={handleProgressComplete}
                            onError={(error) => handleProgressError(error, progressData.progressId)}
                            onProgress={handleProgressUpdate}
                            onRetry={() => handleRetryProgress(progressData.progressId)}
                            onDismiss={() => {
                              // Remove from UI
                              setProgressItems(prev => prev.filter(item => item.progressId !== progressData.progressId));
                              // Clean up from localStorage
                              try {
                                localStorage.removeItem(`crawl_progress_${progressData.progressId}`);
                                const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
                                const updated = activeCrawls.filter((id: string) => id !== progressData.progressId);
                                localStorage.setItem('active_crawls', JSON.stringify(updated));
                              } catch (error) {
                                console.error('Failed to clean up dismissed crawl:', error);
                              }
                            }}
                            onStop={() => handleStopProgress(progressData.progressId)}
                          />
                        </motion.div>
                      ))}
                    </div>
                    
                    {/* Right area for knowledge items grid */}
                    <div className="flex-1">
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {/* Manually grouped items */}
                        {groupedItems.map(groupedItem => (
                          <motion.div key={groupedItem.id} variants={contentItemVariants}>
                            <GroupedKnowledgeItemCard 
                              groupedItem={groupedItem} 
                              onDelete={handleDeleteItem}
                              onUpdate={loadKnowledgeItems}
                              onRefresh={handleRefreshItem}
                            />
                          </motion.div>
                        ))}
                        
                        {/* Ungrouped items */}
                        {ungroupedItems.map((item, index) => (
                          <motion.div key={item.id} variants={contentItemVariants}>
                            <KnowledgeItemCard 
                              item={item} 
                              onDelete={handleDeleteItem} 
                              onUpdate={loadKnowledgeItems} 
                              onRefresh={handleRefreshItem}
                              isSelectionMode={isSelectionMode}
                              isSelected={selectedItems.has(item.id)}
                              onToggleSelection={(e) => toggleItemSelection(item.id, index, e)}
                            />
                          </motion.div>
                        ))}
                        
                        {/* No items message */}
                        {groupedItems.length === 0 && ungroupedItems.length === 0 && (
                          <div className="col-span-full py-10 text-center text-gray-500 dark:text-zinc-400">
                            No knowledge items found for the selected filter.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  // Original layout when no progress items or in list view
                  <div className={`grid ${viewMode === 'grid' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'grid-cols-1 gap-3'}`}>
                    {/* Progress Items (only in list view) */}
                    {viewMode === 'list' && progressItems.map(progressData => (
                      <motion.div key={progressData.progressId} variants={contentItemVariants}>
                        <CrawlingProgressCard 
                          progressData={progressData}
                          onComplete={handleProgressComplete}
                          onError={(error) => handleProgressError(error, progressData.progressId)}
                          onProgress={handleProgressUpdate}
                          onRetry={() => handleRetryProgress(progressData.progressId)}
                          onDismiss={() => {
                            // Remove from UI
                            setProgressItems(prev => prev.filter(item => item.progressId !== progressData.progressId));
                            // Clean up from localStorage
                            try {
                              localStorage.removeItem(`crawl_progress_${progressData.progressId}`);
                              const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
                              const updated = activeCrawls.filter((id: string) => id !== progressData.progressId);
                              localStorage.setItem('active_crawls', JSON.stringify(updated));
                            } catch (error) {
                              console.error('Failed to clean up dismissed crawl:', error);
                            }
                          }}
                          onStop={() => handleStopProgress(progressData.progressId)}
                        />
                      </motion.div>
                    ))}
                    
                    {/* Regular Knowledge Items */}
                    {viewMode === 'grid' ? (
                  // Grid view - show grouped items first, then ungrouped
                  <>
                    {/* Manually grouped items */}
                    {groupedItems.map(groupedItem => (
                      <motion.div key={groupedItem.id} variants={contentItemVariants}>
                        <GroupedKnowledgeItemCard 
                          groupedItem={groupedItem} 
                          onDelete={handleDeleteItem}
                          onUpdate={loadKnowledgeItems}
                          onRefresh={handleRefreshItem}
                        />
                      </motion.div>
                    ))}
                    
                    {/* Ungrouped items */}
                    {ungroupedItems.map((item, index) => (
                      <motion.div key={item.id} variants={contentItemVariants}>
                        <KnowledgeItemCard 
                          item={item} 
                          onDelete={handleDeleteItem} 
                          onUpdate={loadKnowledgeItems} 
                          onRefresh={handleRefreshItem}
                          isSelectionMode={isSelectionMode}
                          isSelected={selectedItems.has(item.id)}
                          onToggleSelection={(e) => toggleItemSelection(item.id, index, e)}
                        />
                      </motion.div>
                    ))}
                    
                    {/* No items message */}
                    {groupedItems.length === 0 && ungroupedItems.length === 0 && progressItems.length === 0 && (
                      <motion.div variants={contentItemVariants} className="col-span-full py-10 text-center text-gray-500 dark:text-zinc-400">
                        No knowledge items found for the selected filter.
                      </motion.div>
                    )}
                  </>
                ) : (
                  // List view - use individual items
                  filteredItems.length > 0 ? filteredItems.map((item, index) => (
                    <motion.div key={item.id} variants={contentItemVariants}>
                      <KnowledgeItemCard 
                        item={item} 
                        onDelete={handleDeleteItem} 
                        onUpdate={loadKnowledgeItems} 
                        onRefresh={handleRefreshItem}
                        isSelectionMode={isSelectionMode}
                        isSelected={selectedItems.has(item.id)}
                        onToggleSelection={(e) => toggleItemSelection(item.id, index, e)}
                      />
                    </motion.div>
                  )) : (progressItems.length === 0 && (
                    <motion.div variants={contentItemVariants} className="col-span-full py-10 text-center text-gray-500 dark:text-zinc-400">
                      No knowledge items found for the selected filter.
                    </motion.div>
                  ))
                )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
      {/* Add Knowledge Modal */}
      {isAddModalOpen && <AddKnowledgeModal 
        onClose={() => setIsAddModalOpen(false)} 
        onSuccess={() => {
          loadKnowledgeItems();
          setIsAddModalOpen(false);
        }}
        onStartCrawl={handleStartCrawl}
      />}
      
      {/* Group Creation Modal */}
      {isGroupModalOpen && (
        <GroupCreationModal
          selectedItems={knowledgeItems.filter(item => selectedItems.has(item.id))}
          onClose={() => setIsGroupModalOpen(false)}
          onSuccess={() => {
            setIsGroupModalOpen(false);
            toggleSelectionMode(); // Exit selection mode
            loadKnowledgeItems(); // Reload to show groups
          }}
        />
      )}
    </div>;
};





interface AddKnowledgeModalProps {
  onClose: () => void;
  onSuccess: () => void;
  onStartCrawl: (progressId: string, initialData: Partial<CrawlProgressData>) => void;
}

const AddKnowledgeModal = ({
  onClose,
  onSuccess,
  onStartCrawl
}: AddKnowledgeModalProps) => {
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [knowledgeType, setKnowledgeType] = useState<'technical' | 'business'>('technical');
  const [loading, setLoading] = useState(false);
  const [crawlDepth, setCrawlDepth] = useState(2);
  const [showDepthTooltip, setShowDepthTooltip] = useState(false);
  
  // Advanced domain configuration
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [excludedDomains, setExcludedDomains] = useState<string[]>([]);
  const [includePatterns, setIncludePatterns] = useState<string[]>([]);
  const [excludePatterns, setExcludePatterns] = useState<string[]>([]);
  const [newAllowedDomain, setNewAllowedDomain] = useState('');
  const [newExcludedDomain, setNewExcludedDomain] = useState('');
  const [newIncludePattern, setNewIncludePattern] = useState('');
  const [newExcludePattern, setNewExcludePattern] = useState('');
  
  const { showToast } = useToast();

  // URL validation function that checks domain existence
  const validateUrl = async (url: string): Promise<{ isValid: boolean; error?: string; formattedUrl?: string }> => {
    try {
      // Basic format validation and URL formatting
      let formattedUrl = url.trim();
      if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
        formattedUrl = `https://${formattedUrl}`;
      }
      
      // Check if it's a valid URL format
      let urlObj;
      try {
        urlObj = new URL(formattedUrl);
      } catch (urlError) {
        return { isValid: false, error: 'Please enter a valid URL format (e.g., https://example.com)' };
      }
      
      // Check if hostname has a valid domain structure
      const hostname = urlObj.hostname;
      if (!hostname || hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        // Allow localhost and IP addresses for development
        return { isValid: true, formattedUrl };
      }
      
      // Check if domain has at least one dot (basic domain validation)
      if (!hostname.includes('.')) {
        return { isValid: false, error: 'Please enter a valid domain name (e.g., example.com)' };
      }
      
      // Check if domain has a valid TLD (at least 2 characters after the last dot)
      const parts = hostname.split('.');
      const tld = parts[parts.length - 1];
      if (tld.length < 2) {
        return { isValid: false, error: 'Please enter a valid domain with a proper extension (e.g., .com, .org)' };
      }
      
      // Basic DNS check by trying to resolve the domain
      try {
        const response = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        
        if (response.ok) {
          const dnsResult = await response.json();
          if (dnsResult.Status === 0 && dnsResult.Answer && dnsResult.Answer.length > 0) {
            return { isValid: true, formattedUrl };
          } else {
            return { isValid: false, error: `Domain "${hostname}" could not be resolved. Please check the URL.` };
          }
        } else {
          // If DNS check fails, allow the URL (might be a temporary DNS issue)
          console.warn('DNS check failed, allowing URL anyway:', hostname);
          return { isValid: true, formattedUrl };
        }
      } catch (dnsError) {
        // If DNS check fails, allow the URL (might be a network issue)
        console.warn('DNS check error, allowing URL anyway:', dnsError);
        return { isValid: true, formattedUrl };
      }
    } catch (error) {
      return { isValid: false, error: 'URL validation failed. Please check the URL format.' };
    }
  };

  // Helper functions for domain/pattern management
  const parseDomainList = (input: string): string[] => {
    return input.split(',')
      .map(domain => domain.trim())
      .filter(domain => domain.length > 0);
  };

  const addDomainsToList = (input: string, currentList: string[], setter: (list: string[]) => void) => {
    const domains = parseDomainList(input);
    const newDomains = domains.filter(domain => !currentList.includes(domain));
    if (newDomains.length > 0) {
      setter([...currentList, ...newDomains]);
    }
  };

  const removeDomainFromList = (domain: string, currentList: string[], setter: (list: string[]) => void) => {
    setter(currentList.filter(d => d !== domain));
  };

  const handleDomainInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, input: string, currentList: string[], setter: (list: string[]) => void, inputSetter: (value: string) => void) => {
    if (e.key === 'Enter' && input.trim()) {
      addDomainsToList(input, currentList, setter);
      inputSetter('');
    }
  };

  const handleDomainInputBlur = (input: string, currentList: string[], setter: (list: string[]) => void, inputSetter: (value: string) => void) => {
    if (input.trim()) {
      addDomainsToList(input, currentList, setter);
      inputSetter('');
    }
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      
      if (!url.trim()) {
        showToast('Please enter a URL', 'error');
        return;
      }
      
      // Validate URL and check domain existence
      showToast('Validating URL...', 'info');
      const validation = await validateUrl(url);
      
      if (!validation.isValid) {
        showToast(validation.error || 'Invalid URL', 'error');
        return;
      }
      
      const formattedUrl = validation.formattedUrl!;
      setUrl(formattedUrl); // Update the input field to show the corrected URL
      
      // Build crawl config if advanced options are configured
      const crawlConfig = (allowedDomains.length > 0 || excludedDomains.length > 0 || 
                         includePatterns.length > 0 || excludePatterns.length > 0) ? {
        allowed_domains: allowedDomains,
        excluded_domains: excludedDomains,
        include_patterns: includePatterns,
        exclude_patterns: excludePatterns
      } : undefined;

      const result = await knowledgeBaseService.crawlUrl({
        url: formattedUrl,
        knowledge_type: knowledgeType,
        tags,
        max_depth: crawlDepth,
        crawl_config: crawlConfig
      });
      
      // Check if result contains a progressId for streaming
      if ((result as any).progressId) {
        // Start progress tracking
        onStartCrawl((result as any).progressId, {
          status: 'initializing',
          percentage: 0,
          currentStep: 'Starting crawl'
        });
        
        showToast('Crawling started - tracking progress', 'success');
        onClose(); // Close modal immediately
      } else {
        // Fallback for non-streaming response
        showToast((result as any).message || 'Crawling started', 'success');
        onSuccess();
      }
    } catch (error) {
      console.error('Failed to add knowledge:', error);
      showToast('Failed to add knowledge source', 'error');
    } finally {
      setLoading(false);
    }
  };

  return <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <Card className="w-full max-w-2xl relative before:content-[''] before:absolute before:top-0 before:left-0 before:w-full before:h-[1px] before:bg-green-500 p-8 my-8 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-8">
          Crawl Website with Advanced Domain Filtering
        </h2>
        {/* Knowledge Type Selection */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
            Knowledge Type
          </label>
          <div className="flex gap-4">
            <label className={`
                flex-1 p-4 rounded-md border cursor-pointer transition flex items-center justify-center gap-2
                ${knowledgeType === 'technical' ? 'border-blue-500 text-blue-600 dark:text-blue-500 bg-blue-50 dark:bg-blue-500/5' : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-blue-300 dark:hover:border-blue-500/30'}
              `}>
              <input type="radio" name="knowledgeType" value="technical" checked={knowledgeType === 'technical'} onChange={() => setKnowledgeType('technical')} className="sr-only" />
              <BoxIcon className="w-5 h-5" />
              <span>Technical/Coding</span>
            </label>
            <label className={`
                flex-1 p-4 rounded-md border cursor-pointer transition flex items-center justify-center gap-2
                ${knowledgeType === 'business' ? 'border-purple-500 text-purple-600 dark:text-purple-500 bg-purple-50 dark:bg-purple-500/5' : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-purple-300 dark:hover:border-purple-500/30'}
              `}>
              <input type="radio" name="knowledgeType" value="business" checked={knowledgeType === 'business'} onChange={() => setKnowledgeType('business')} className="sr-only" />
              <Brain className="w-5 h-5" />
              <span>Business/Project</span>
            </label>
          </div>
        </div>
        {/* URL Input */}
        <div className="mb-6">
          <Input 
            label="URL to Scrape" 
            type="url" 
            value={url} 
            onChange={e => setUrl(e.target.value)} 
            placeholder="https://example.com or example.com" 
            accentColor="blue" 
          />
          {url && !url.startsWith('http://') && !url.startsWith('https://') && (
            <p className="text-amber-600 dark:text-amber-400 text-sm mt-1">
              ℹ️ Will automatically add https:// prefix
            </p>
          )}
        </div>

        {/* Crawl Depth */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-4">
            Crawl Depth
            <button
              type="button"
              className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              onMouseEnter={() => setShowDepthTooltip(true)}
              onMouseLeave={() => setShowDepthTooltip(false)}
            >
              <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </label>
          
          <GlassCrawlDepthSelector
            value={crawlDepth}
            onChange={setCrawlDepth}
            showTooltip={showDepthTooltip}
            onTooltipToggle={setShowDepthTooltip}
          />
        </div>

        {/* Advanced Domain Configuration */}
        <div className="mb-6">
          <button
            type="button"
            onClick={() => setShowAdvancedConfig(!showAdvancedConfig)}
            className="flex items-center justify-between w-full p-3 text-left bg-gray-50 dark:bg-zinc-900 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Advanced Domain Configuration
            </span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showAdvancedConfig ? 'rotate-180' : ''}`} />
          </button>

          {showAdvancedConfig && (
          <div className="mb-6">
            <button
              type="button"
              onClick={() => setShowAdvancedConfig(!showAdvancedConfig)}
              className="flex items-center justify-between w-full p-3 text-left bg-gray-50 dark:bg-zinc-900 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Advanced Domain Configuration
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showAdvancedConfig ? 'rotate-180' : ''}`} />
            </button>
            
            <div className={`mt-4 space-y-4 transition-all duration-200 ${showAdvancedConfig ? 'block' : 'hidden'}`}>
              {/* Allowed Domains */}
              <div>
                <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
                  Allowed Domains (Whitelist)
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {allowedDomains.map(domain => (
                    <Badge key={domain} color="green" variant="outline" className="flex items-center gap-1">
                      {domain}
                      <X 
                        className="w-3 h-3 cursor-pointer hover:text-red-500" 
                        onClick={() => removeDomainFromList(domain, allowedDomains, setAllowedDomains)}
                      />
                    </Badge>
                  ))}
                </div>
                <Input
                  type="text"
                  value={newAllowedDomain}
                  onChange={e => setNewAllowedDomain(e.target.value)}
                  onKeyDown={e => handleDomainInputKeyDown(e, newAllowedDomain, allowedDomains, setAllowedDomains, setNewAllowedDomain)}
                  onBlur={() => handleDomainInputBlur(newAllowedDomain, allowedDomains, setAllowedDomains, setNewAllowedDomain)}
                  placeholder="docs.example.com, api.example.com (comma-separated)"
                  accentColor="green"
                />
              </div>

              {/* Excluded Domains */}
              <div>
                <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
                  Excluded Domains (Blacklist)
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {excludedDomains.map(domain => (
                    <Badge key={domain} color="red" variant="outline" className="flex items-center gap-1">
                      {domain}
                      <X 
                        className="w-3 h-3 cursor-pointer hover:text-red-500" 
                        onClick={() => removeDomainFromList(domain, excludedDomains, setExcludedDomains)}
                      />
                    </Badge>
                  ))}
                </div>
                <Input
                  type="text"
                  value={newExcludedDomain}
                  onChange={e => setNewExcludedDomain(e.target.value)}
                  onKeyDown={e => handleDomainInputKeyDown(e, newExcludedDomain, excludedDomains, setExcludedDomains, setNewExcludedDomain)}
                  onBlur={() => handleDomainInputBlur(newExcludedDomain, excludedDomains, setExcludedDomains, setNewExcludedDomain)}
                  placeholder="spam.example.com, ads.example.com (comma-separated)"
                  accentColor="red"
                />
              </div>

              {/* Include Patterns */}
              <div>
                <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
                  Include URL Patterns (Glob-style)
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {includePatterns.map(pattern => (
                    <Badge key={pattern} color="blue" variant="outline" className="flex items-center gap-1">
                      {pattern}
                      <X 
                        className="w-3 h-3 cursor-pointer hover:text-red-500" 
                        onClick={() => removeDomainFromList(pattern, includePatterns, setIncludePatterns)}
                      />
                    </Badge>
                  ))}
                </div>
                <Input
                  type="text"
                  value={newIncludePattern}
                  onChange={e => setNewIncludePattern(e.target.value)}
                  onKeyDown={e => handleDomainInputKeyDown(e, newIncludePattern, includePatterns, setIncludePatterns, setNewIncludePattern)}
                  onBlur={() => handleDomainInputBlur(newIncludePattern, includePatterns, setIncludePatterns, setNewIncludePattern)}
                  placeholder="*/docs/*, */api/* (comma-separated)"
                  accentColor="blue"
                />
              </div>

              {/* Exclude Patterns */}
              <div>
                <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
                  Exclude URL Patterns (Glob-style)
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {excludePatterns.map(pattern => (
                    <Badge key={pattern} color="orange" variant="outline" className="flex items-center gap-1">
                      {pattern}
                      <X 
                        className="w-3 h-3 cursor-pointer hover:text-red-500" 
                        onClick={() => removeDomainFromList(pattern, excludePatterns, setExcludePatterns)}
                      />
                    </Badge>
                  ))}
                </div>
                <Input
                  type="text"
                  value={newExcludePattern}
                  onChange={e => setNewExcludePattern(e.target.value)}
                  onKeyDown={e => handleDomainInputKeyDown(e, newExcludePattern, excludePatterns, setExcludePatterns, setNewExcludePattern)}
                  onBlur={() => handleDomainInputBlur(newExcludePattern, excludePatterns, setExcludePatterns, setNewExcludePattern)}
                  placeholder="*/admin/*, */private/* (comma-separated)"
                  accentColor="orange"
                />
              </div>

              <div className="text-xs text-gray-500 dark:text-zinc-600 mt-2">
                <p>• Leave empty to crawl all pages found on the site</p>
                <p>• Use allowed domains to restrict crawling to specific subdomains</p>
                <p>• Use patterns to include/exclude specific URL structures</p>
              </div>
            </div>
          </div>
        )}
        
        {/* Tags */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
            Tags (AI will add recommended tags if left blank)
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {tags.map(tag => <Badge key={tag} color="purple" variant="outline">
                {tag}
              </Badge>)}
          </div>
          <Input type="text" value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => {
          if (e.key === 'Enter' && newTag.trim()) {
            setTags([...tags, newTag.trim()]);
            setNewTag('');
          }
        }} placeholder="Add tags..." accentColor="purple" />
        </div>
        {/* Action Buttons */}
        <div className="flex justify-end gap-4">
          <Button onClick={onClose} variant="ghost" disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} variant="primary" accentColor={method === 'url' ? 'blue' : 'pink'} disabled={loading}>
            {loading ? 'Adding...' : 'Add Source'}
          </Button>
        </div>
      </Card>
    </div>;
};

