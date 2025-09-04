import { useEffect, useState, useRef, useMemo } from 'react';
import { Search, Grid, Plus, Filter, BoxIcon, List, BookOpen, CheckSquare, Brain } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { useStaggeredEntrance } from '../hooks/useStaggeredEntrance';
import { useToast } from '../contexts/ToastContext';
import { knowledgeBaseService, KnowledgeItem, KnowledgeItemMetadata } from '../services/knowledgeBaseService';
import { CrawlProgressData } from '../types/crawl';
import { KnowledgeTable } from '../components/knowledge-base/KnowledgeTable';
import { KnowledgeItemCard } from '../components/knowledge-base/KnowledgeItemCard';
import { GroupedKnowledgeItemCard } from '../components/knowledge-base/GroupedKnowledgeItemCard';
import { KnowledgeGridSkeleton, KnowledgeTableSkeleton } from '../components/knowledge-base/KnowledgeItemSkeleton';
import { GroupCreationModal } from '../components/knowledge-base/GroupCreationModal';
import { AddKnowledgeModal } from '../components/knowledge-base/AddKnowledgeModal';
import { CrawlingTab } from '../components/knowledge-base/CrawlingTab';

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
  const [loading, setLoading] = useState(true);
  const [totalItems, setTotalItems] = useState(0);
  const [progressItems, setProgressItemsRaw] = useState<CrawlProgressData[]>([]);
  const [showCrawlingTab, setShowCrawlingTab] = useState(false);
  
  // Wrapper to ensure progress items are always unique
  const setProgressItems = (updater: CrawlProgressData[] | ((prev: CrawlProgressData[]) => CrawlProgressData[])) => {
    setProgressItemsRaw(prev => {
      const newItems = typeof updater === 'function' ? updater(prev) : updater;
      const itemMap = new Map(newItems.map(item => [item.progressId, item]));
      return Array.from(itemMap.values());
    });
  };
  
  // Selection state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  
  const { showToast } = useToast();

  // Load knowledge items
  const loadKnowledgeItems = async () => {
    try {
      setLoading(true);
      const response = await knowledgeBaseService.getKnowledgeItems({
        page: 1,
        per_page: 100
      });
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

  // Initialize on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      loadKnowledgeItems();
    }, 100);
    
    return () => clearTimeout(timer);
  }, []);

  // Check for active progress on mount
  useEffect(() => {
    const activeCrawlsStr = localStorage.getItem('active_crawls');
    const activeCrawls = JSON.parse(activeCrawlsStr || '[]');
    
    if (activeCrawls.length > 0) {
      const restoredItems: CrawlProgressData[] = [];
      const staleItems: string[] = [];
      
      for (const crawlId of activeCrawls) {
        const crawlData = localStorage.getItem(`crawl_progress_${crawlId}`);
        
        if (crawlData) {
          try {
            const parsed = JSON.parse(crawlData);
            
            // Check if crawl is in a completed state or too old
            const isCompleted = ['completed', 'error', 'failed', 'cancelled'].includes(parsed.status);
            const now = Date.now();
            const startedAt = parsed.startedAt || now;
            const ageMinutes = (now - startedAt) / (1000 * 60);
            const isStale = ageMinutes > 5; // Clean up crawls older than 5 minutes on page refresh
            
            if (isCompleted || isStale) {
              staleItems.push(crawlId);
              console.log(`Removing ${isCompleted ? 'completed' : 'stale'} crawl: ${crawlId} (age: ${ageMinutes.toFixed(1)}min, status: ${parsed.status})`);
            } else {
              // Before restoring, verify the progress still exists on the server
              restoredItems.push({
                ...parsed,
                progressId: crawlId,
                _needsVerification: true // Flag for verification
              });
              console.log(`Queued for verification: ${crawlId} (age: ${ageMinutes.toFixed(1)}min, status: ${parsed.status})`);
            }
          } catch {
            staleItems.push(crawlId);
          }
        } else {
          staleItems.push(crawlId);
        }
      }
      
      // Clean up stale items
      if (staleItems.length > 0) {
        const updatedCrawls = activeCrawls.filter((id: string) => !staleItems.includes(id));
        localStorage.setItem('active_crawls', JSON.stringify(updatedCrawls));
        staleItems.forEach(id => {
          localStorage.removeItem(`crawl_progress_${id}`);
        });
      }
      
      // Verify and restore progress items
      if (restoredItems.length > 0) {
        setShowCrawlingTab(true);
        
        // Verify each item still exists on server
        verifyAndRestoreProgressItems(restoredItems);
      }
    }
  }, []);

  // Verify progress items still exist on server before restoring
  const verifyAndRestoreProgressItems = async (itemsToVerify: CrawlProgressData[]) => {
    const verifiedItems: CrawlProgressData[] = [];
    const itemsToRemove: string[] = [];
    
    for (const item of itemsToVerify) {
      try {
        // Try to fetch current progress from server
        const response = await fetch(`/api/progress/${item.progressId}`, {
          method: 'GET',
          credentials: 'include',
        });
        
        if (response.ok) {
          // Progress still exists, add to verified items
          verifiedItems.push(item);
          console.log(`Verified active progress: ${item.progressId}`);
        } else if (response.status === 404) {
          // Progress no longer exists, mark for removal
          itemsToRemove.push(item.progressId);
          console.log(`Progress no longer exists on server: ${item.progressId}`);
        }
      } catch (error) {
        // Network error or other issue, assume stale
        itemsToRemove.push(item.progressId);
        console.log(`Failed to verify progress (assuming stale): ${item.progressId}`);
      }
    }
    
    // Clean up items that no longer exist
    if (itemsToRemove.length > 0) {
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updatedCrawls = activeCrawls.filter((id: string) => !itemsToRemove.includes(id));
      localStorage.setItem('active_crawls', JSON.stringify(updatedCrawls));
      
      itemsToRemove.forEach(id => {
        localStorage.removeItem(`crawl_progress_${id}`);
      });
      
      console.log(`Cleaned up ${itemsToRemove.length} stale progress items`);
    }
    
    // Set only verified items
    if (verifiedItems.length > 0) {
      setProgressItems(verifiedItems);
      console.log(`Restored ${verifiedItems.length} verified progress items`);
    } else {
      setShowCrawlingTab(false);
      console.log('No active progress items found after verification');
    }
  };

  // Note: Completion refresh is now handled immediately in handleProgressComplete

  // Filtered items
  const filteredItems = useMemo(() => {
    return knowledgeItems.filter(item => {
      const typeMatch = typeFilter === 'all' || item.metadata.knowledge_type === typeFilter;
      const searchLower = searchQuery.toLowerCase();
      const searchMatch = !searchQuery || 
        item.title.toLowerCase().includes(searchLower) ||
        item.metadata.description?.toLowerCase().includes(searchLower) ||
        item.metadata.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ||
        item.source_id.toLowerCase().includes(searchLower);
      
      return typeMatch && searchMatch;
    });
  }, [knowledgeItems, typeFilter, searchQuery]);

  // Grouped items
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
            domain: groupName,
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
  
  const ungroupedItems = useMemo(() => {
    return viewMode === 'grid' ? filteredItems.filter(item => !item.metadata?.group_name) : [];
  }, [filteredItems, viewMode]);

  // Animation variants
  const {
    containerVariants: headerContainerVariants,
    itemVariants: headerItemVariants,
    titleVariants
  } = useStaggeredEntrance([1, 2], 0.15);

  const {
    containerVariants: contentContainerVariants,
    itemVariants: contentItemVariants
  } = useStaggeredEntrance(filteredItems, 0.15);

  // Handlers
  const handleAddKnowledge = () => {
    setIsAddModalOpen(true);
  };
  
  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    if (isSelectionMode) {
      setSelectedItems(new Set());
      setLastSelectedIndex(null);
    }
  };
  
  const toggleItemSelection = (itemId: string, index: number, event: React.MouseEvent) => {
    const newSelected = new Set(selectedItems);
    
    if (event.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      for (let i = start; i <= end; i++) {
        if (filteredItems[i]) {
          newSelected.add(filteredItems[i].id);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (newSelected.has(itemId)) {
        newSelected.delete(itemId);
      } else {
        newSelected.add(itemId);
      }
    } else {
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
      const deletePromises = Array.from(selectedItems).map(itemId => 
        knowledgeBaseService.deleteKnowledgeItem(itemId)
      );
      
      await Promise.all(deletePromises);
      
      setKnowledgeItems(prev => prev.filter(item => !selectedItems.has(item.id)));
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && isSelectionMode) {
        e.preventDefault();
        selectAll();
      }
      
      if (e.key === 'Escape' && isSelectionMode) {
        toggleSelectionMode();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectionMode, filteredItems]);

  const handleRefreshItem = async (sourceId: string) => {
    try {
      const item = knowledgeItems.find(k => k.source_id === sourceId);
      if (!item) return;
      
      const response = await knowledgeBaseService.refreshKnowledgeItem(sourceId);
      
      if (response.progressId) {
        const progressData: CrawlProgressData = {
          progressId: response.progressId,
          currentUrl: item.url,
          totalPages: 0,
          processedPages: 0,
          progress: 0,
          status: 'starting',
          message: 'Starting refresh...',
          crawlType: 'refresh',
          currentStep: 'starting',
          startTime: new Date()
        };
        
        setProgressItems(prev => [...prev, progressData]);
        setShowCrawlingTab(true);
        
        // Store in localStorage
        localStorage.setItem(`crawl_progress_${response.progressId}`, JSON.stringify({
          ...progressData,
          startedAt: Date.now()
        }));
        
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        if (!activeCrawls.includes(response.progressId)) {
          activeCrawls.push(response.progressId);
          localStorage.setItem('active_crawls', JSON.stringify(activeCrawls));
        }
        
        setKnowledgeItems(prev => prev.filter(k => k.source_id !== sourceId));
      }
    } catch (error) {
      console.error('Failed to refresh knowledge item:', error);
      showToast('Failed to refresh knowledge item', 'error');
    }
  };

  const handleDeleteItem = async (sourceId: string) => {
    try {
      if (sourceId.startsWith('group_')) {
        const groupName = sourceId.replace('group_', '').replace(/_/g, ' ');
        const group = groupedItems.find(g => g.title === groupName);
        
        if (group) {
          const deletedIds: string[] = [];
          for (const item of group.items) {
            await knowledgeBaseService.deleteKnowledgeItem(item.source_id);
            deletedIds.push(item.source_id);
          }
          
          setKnowledgeItems(prev => prev.filter(item => !deletedIds.includes(item.source_id)));
          showToast(`Deleted ${group.items.length} items from group "${groupName}"`, 'success');
        }
      } else {
        const result = await knowledgeBaseService.deleteKnowledgeItem(sourceId);
        setKnowledgeItems(prev => prev.filter(item => item.source_id !== sourceId));
        showToast((result as any).message || 'Item deleted', 'success');
      }
    } catch (error) {
      console.error('Failed to delete item:', error);
      showToast('Failed to delete item', 'error');
    }
  };

  // Progress handling
  const handleProgressComplete = (data: CrawlProgressData) => {
    // Clean up localStorage immediately
    localStorage.removeItem(`crawl_progress_${data.progressId}`);
    const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
    const updated = activeCrawls.filter((id: string) => id !== data.progressId);
    localStorage.setItem('active_crawls', JSON.stringify(updated));
    
    // Show success message
    const message = data.uploadType === 'document' 
      ? `Document "${data.fileName}" uploaded successfully!`
      : `Crawling completed for ${data.currentUrl}!`;
    showToast(message, 'success');
    
    // Immediately remove progress card and refresh sources
    setProgressItems(prev => {
      const filtered = prev.filter(item => item.progressId !== data.progressId);
      // Hide crawling tab if this was the last item
      if (filtered.length === 0) {
        setShowCrawlingTab(false);
      }
      return filtered;
    });
    
    // Immediately refresh sources list to show the new completed source
    loadKnowledgeItems();
  };

  const handleProgressError = (error: string, progressId?: string) => {
    if (progressId) {
      setProgressItems(prev => prev.map(item => 
        item.progressId === progressId 
          ? { ...item, status: 'failed', error }
          : item
      ));
      
      localStorage.removeItem(`crawl_progress_${progressId}`);
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updated = activeCrawls.filter((id: string) => id !== progressId);
      localStorage.setItem('active_crawls', JSON.stringify(updated));
      
      setTimeout(() => {
        setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
        if (progressItems.length === 1) {
          setShowCrawlingTab(false);
        }
      }, 5000);
    }
    showToast(`Crawling failed: ${error}`, 'error');
  };

  const handleRetryProgress = async (progressId: string) => {
    const progressItem = progressItems.find(item => item.progressId === progressId);
    if (!progressItem) {
      showToast('Progress item not found', 'error');
      return;
    }

    try {
      setProgressItems(prev => prev.map(item => 
        item.progressId === progressId 
          ? { ...item, status: 'starting', error: undefined, message: 'Retrying...' }
          : item
      ));
      
      localStorage.removeItem(`crawl_progress_${progressId}`);
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updated = activeCrawls.filter((id: string) => id !== progressId);
      localStorage.setItem('active_crawls', JSON.stringify(updated));

      if (progressItem.originalCrawlParams) {
        showToast('Retrying crawl...', 'info');
        const result = await knowledgeBaseService.crawlUrl(progressItem.originalCrawlParams);
        
        if ((result as any).progressId) {
          await handleStartCrawl((result as any).progressId, {
            currentUrl: progressItem.originalCrawlParams.url,
            totalPages: 0,
            processedPages: 0,
            originalCrawlParams: progressItem.originalCrawlParams
          });
          showToast('Crawl restarted successfully', 'success');
        }
      }
    } catch (error) {
      console.error('Failed to retry:', error);
      showToast('Retry failed', 'error');
    }
  };

  const handleStopProgress = async (progressId: string) => {
    try {
      await knowledgeBaseService.stopCrawl(progressId);
      
      setProgressItems(prev => prev.map(item => 
        item.progressId === progressId 
          ? { ...item, status: 'cancelled' }
          : item
      ));
      
      const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
      const updated = activeCrawls.filter((id: string) => id !== progressId);
      localStorage.setItem('active_crawls', JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to stop crawl:', error);
      showToast('Failed to stop crawl', 'error');
    }
  };

  const handleDismissProgress = (progressId: string) => {
    setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
    if (progressItems.length === 1) {
      setShowCrawlingTab(false);
    }
    
    localStorage.removeItem(`crawl_progress_${progressId}`);
    const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
    const updated = activeCrawls.filter((id: string) => id !== progressId);
    localStorage.setItem('active_crawls', JSON.stringify(updated));
  };

  const handleStartCrawl = async (progressId: string, initialData: Partial<CrawlProgressData>) => {
    const newProgressItem: CrawlProgressData = {
      ...initialData,
      progressId,
      status: 'starting',
      progress: 0,
      message: 'Starting crawl...'
    } as CrawlProgressData;
    
    setProgressItems(prev => [...prev, newProgressItem]);
    setShowCrawlingTab(true);
    
    localStorage.setItem(`crawl_progress_${progressId}`, JSON.stringify({
      ...newProgressItem,
      startedAt: Date.now()
    }));
    
    const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
    if (!activeCrawls.includes(progressId)) {
      activeCrawls.push(progressId);
      localStorage.setItem('active_crawls', JSON.stringify(activeCrawls));
    }
  };

  return (
    <div>
      {/* Header */}
      <motion.div 
        className="flex justify-between items-center mb-8" 
        initial="hidden" 
        animate="visible" 
        variants={headerContainerVariants}
      >
        <motion.h1 
          className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3" 
          variants={titleVariants}
        >
          <BookOpen className="w-7 h-7 text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]" />
          Knowledge Base
        </motion.h1>
        <motion.div className="flex items-center gap-4" variants={headerItemVariants}>
          <div className="relative">
            <Input 
              type="text" 
              value={searchQuery} 
              onChange={e => setSearchQuery(e.target.value)} 
              placeholder="Search knowledge base..." 
              accentColor="purple" 
              icon={<Search className="w-4 h-4" />} 
            />
          </div>
          
          <div className="flex items-center bg-gray-50 dark:bg-black border border-gray-200 dark:border-zinc-900 rounded-md overflow-hidden">
            <button 
              onClick={() => setTypeFilter('all')} 
              className={`p-2 ${typeFilter === 'all' ? 'bg-gray-200 dark:bg-zinc-800 text-gray-800 dark:text-white' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} 
              title="All Types"
            >
              <Filter className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setTypeFilter('technical')} 
              className={`p-2 ${typeFilter === 'technical' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} 
              title="Technical/Coding"
            >
              <BoxIcon className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setTypeFilter('business')} 
              className={`p-2 ${typeFilter === 'business' ? 'bg-pink-100 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} 
              title="Business/Project"
            >
              <Brain className="w-4 h-4" />
            </button>
          </div>
          
          <div className="flex items-center bg-gray-50 dark:bg-black border border-gray-200 dark:border-zinc-900 rounded-md overflow-hidden">
            <button 
              onClick={() => setViewMode('grid')} 
              className={`p-2 ${viewMode === 'grid' ? 'bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-500' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} 
              title="Grid View"
            >
              <Grid className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setViewMode('table')} 
              className={`p-2 ${viewMode === 'table' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-500' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'}`} 
              title="Table View"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          
          <Button 
            onClick={toggleSelectionMode} 
            variant={isSelectionMode ? "secondary" : "ghost"} 
            accentColor="blue"
            className={isSelectionMode ? "bg-blue-500/10 border-blue-500/40" : ""}
          >
            <CheckSquare className="w-4 h-4 mr-2 inline" />
            <span>{isSelectionMode ? 'Cancel' : 'Select'}</span>
          </Button>
          
          <Button 
            onClick={handleAddKnowledge} 
            variant="primary" 
            accentColor="purple" 
            className="shadow-lg shadow-purple-500/20"
          >
            <Plus className="w-4 h-4 mr-2 inline" />
            <span>Knowledge</span>
          </Button>
        </motion.div>
      </motion.div>

      {/* Selection Toolbar */}
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
                  <Button onClick={selectAll} variant="ghost" size="sm" accentColor="blue">
                    Select All
                  </Button>
                  <Button onClick={deselectAll} variant="ghost" size="sm" accentColor="gray">
                    Clear Selection
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={() => setIsGroupModalOpen(true)} variant="secondary" size="sm" accentColor="blue">
                    Create Group
                  </Button>
                  <Button onClick={deleteSelectedItems} variant="secondary" size="sm" accentColor="pink">
                    Delete Selected
                  </Button>
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Active Crawls Tab */}
      {showCrawlingTab && progressItems.length > 0 && (
        <div className="mb-6">
          <CrawlingTab
            progressItems={progressItems}
            onProgressComplete={handleProgressComplete}
            onProgressError={handleProgressError}
            onRetryProgress={handleRetryProgress}
            onStopProgress={handleStopProgress}
            onDismissProgress={handleDismissProgress}
          />
        </div>
      )}

      {/* Main Content */}
      <div className="relative">
        {loading ? (
          viewMode === 'grid' ? <KnowledgeGridSkeleton /> : <KnowledgeTableSkeleton />
        ) : viewMode === 'table' ? (
          <KnowledgeTable items={filteredItems} onDelete={handleDeleteItem} />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div 
              key={`view-${viewMode}-filter-${typeFilter}`} 
              initial="hidden" 
              animate="visible" 
              variants={contentContainerVariants}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                
                {groupedItems.length === 0 && ungroupedItems.length === 0 && (
                  <div className="col-span-full py-10 text-center text-gray-500 dark:text-zinc-400">
                    No knowledge items found for the selected filter.
                  </div>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {/* Modals */}
      {isAddModalOpen && (
        <AddKnowledgeModal 
          onClose={() => setIsAddModalOpen(false)} 
          onSuccess={() => {
            loadKnowledgeItems();
            setIsAddModalOpen(false);
          }}
          onStartCrawl={handleStartCrawl}
        />
      )}
      
      {isGroupModalOpen && (
        <GroupCreationModal
          selectedItems={knowledgeItems.filter(item => selectedItems.has(item.id))}
          onClose={() => setIsGroupModalOpen(false)}
          onSuccess={() => {
            setIsGroupModalOpen(false);
            toggleSelectionMode();
            loadKnowledgeItems();
          }}
        />
      )}
    </div>
  );
};