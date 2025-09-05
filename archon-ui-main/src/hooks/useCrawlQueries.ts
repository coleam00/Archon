import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useCallback } from 'react';
import { knowledgeBaseService, KnowledgeItem } from '../services/knowledgeBaseService';
import { CrawlProgressData } from '../types/crawl';
import { useToast } from '../contexts/ToastContext';

// Query keys factory
export const crawlKeys = {
  all: ['crawl'] as const,
  progress: (progressId: string) => [...crawlKeys.all, 'progress', progressId] as const,
};

export const knowledgeKeys = {
  all: ['knowledge'] as const,
  items: () => [...knowledgeKeys.all, 'items'] as const,
  item: (id: string) => [...knowledgeKeys.all, 'item', id] as const,
  search: (query: string) => [...knowledgeKeys.all, 'search', query] as const,
};

// Fetch crawl progress
export function useCrawlProgressPolling(progressId: string | null, options?: any) {
  const [isComplete, setIsComplete] = useState(false);
  
  // Reset complete state when progressId changes
  useEffect(() => {
    console.log(`📊 Progress ID changed to: ${progressId}, resetting complete state`);
    setIsComplete(false);
  }, [progressId]);
  
  const handleError = useCallback((error: Error) => {
    // Handle permanent resource not found
    if (error.message === 'Resource no longer exists') {
      console.log(`Crawl progress no longer exists for: ${progressId}`);
      
      // Clean up from localStorage
      if (progressId) {
        localStorage.removeItem(`crawl_progress_${progressId}`);
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        const updated = activeCrawls.filter((id: string) => id !== progressId);
        localStorage.setItem('active_crawls', JSON.stringify(updated));
      }
      
      options?.onError?.(error);
      return;
    }
    
    // Log other errors
    if (!error.message.includes('404') && !error.message.includes('Not Found') && 
        !error.message.includes('ERR_INSUFFICIENT_RESOURCES')) {
      console.error('Crawl progress error:', error);
    }
    
    options?.onError?.(error);
  }, [progressId, options]);
  
  const query = useQuery({
    queryKey: crawlKeys.progress(progressId!),
    queryFn: async () => {
      if (!progressId) throw new Error('No progress ID');
      
      const response = await fetch(`/api/progress/${progressId}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      
      if (response.status === 404) {
        // Track consecutive 404s
        const notFoundKey = `crawl_404_${progressId}`;
        const notFoundCount = parseInt(localStorage.getItem(notFoundKey) || '0') + 1;
        localStorage.setItem(notFoundKey, notFoundCount.toString());
        
        if (notFoundCount >= 5) {
          localStorage.removeItem(notFoundKey);
          throw new Error('Resource no longer exists');
        }
        
        console.log(`Resource not found (404), attempt ${notFoundCount}/5: ${progressId}`);
        return null;
      }
      
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }
      
      // Reset 404 counter on success
      localStorage.removeItem(`crawl_404_${progressId}`);
      
      return response.json();
    },
    enabled: !!progressId && !isComplete,
    refetchInterval: 1000, // Poll every second
    retry: false, // Don't retry on error
    staleTime: 0, // Always refetch
    onError: handleError,
  });
  
  // Stop polling when operation is complete or failed
  useEffect(() => {
    const status = query.data?.status;
    if (query.data) {
      console.debug('🔄 Crawl polling data received:', { 
        progressId, 
        status, 
        progress: query.data.progress 
      });
    }
    if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
      console.debug('⏹️ Crawl polling stopping - status:', status);
      setIsComplete(true);
    }
  }, [query.data?.status, progressId]);
  
  // Transform data to expected format
  const transformedData = query.data ? {
    ...query.data,
    progress: query.data.progress || 0,
    logs: query.data.logs || [],
    message: query.data.message || '',
  } : null;
  
  return {
    ...query,
    data: transformedData,
    isComplete
  };
}

// ==================== KNOWLEDGE BASE QUERIES ====================

// Fetch knowledge items
export function useKnowledgeItems(page = 1, perPage = 100) {
  return useQuery({
    queryKey: knowledgeKeys.items(),
    queryFn: async () => {
      const response = await knowledgeBaseService.getKnowledgeItems({
        page,
        per_page: perPage
      });
      return response;
    },
    staleTime: 30000, // Consider data stale after 30 seconds
    cacheTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
  });
}

// Delete knowledge item mutation
export function useDeleteKnowledgeItem() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (sourceId: string) => {
      return await knowledgeBaseService.deleteKnowledgeItem(sourceId);
    },
    onSuccess: (data, sourceId) => {
      // Optimistically update the cache
      queryClient.setQueryData(knowledgeKeys.items(), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.filter((item: KnowledgeItem) => item.source_id !== sourceId),
          total: old.total - 1
        };
      });
      
      showToast('Item deleted successfully', 'success');
    },
    onError: (error) => {
      showToast('Failed to delete item', 'error');
      console.error('Delete failed:', error);
    }
  });
}

// Delete multiple items mutation
export function useDeleteMultipleItems() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (sourceIds: string[]) => {
      const deletePromises = sourceIds.map(id => 
        knowledgeBaseService.deleteKnowledgeItem(id)
      );
      return await Promise.all(deletePromises);
    },
    onSuccess: (data, sourceIds) => {
      // Optimistically update the cache
      queryClient.setQueryData(knowledgeKeys.items(), (old: any) => {
        if (!old) return old;
        const idsSet = new Set(sourceIds);
        return {
          ...old,
          items: old.items.filter((item: KnowledgeItem) => !idsSet.has(item.source_id)),
          total: old.total - sourceIds.length
        };
      });
      
      showToast(`Deleted ${sourceIds.length} items successfully`, 'success');
    },
    onError: (error) => {
      showToast('Failed to delete some items', 'error');
      console.error('Batch delete failed:', error);
    }
  });
}

// Refresh knowledge item mutation
export function useRefreshKnowledgeItem() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (sourceId: string) => {
      return await knowledgeBaseService.refreshKnowledgeItem(sourceId);
    },
    onSuccess: (data, sourceId) => {
      // Remove the item from cache as it's being refreshed
      queryClient.setQueryData(knowledgeKeys.items(), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.filter((item: KnowledgeItem) => item.source_id !== sourceId)
        };
      });
      
      showToast('Refresh started', 'info');
    },
    onError: (error) => {
      showToast('Failed to refresh item', 'error');
      console.error('Refresh failed:', error);
    }
  });
}

// Crawl URL mutation
export function useCrawlUrl() {
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (params: any) => {
      return await knowledgeBaseService.crawlUrl(params);
    },
    onSuccess: (data) => {
      if (data.progressId) {
        showToast('Crawl started successfully', 'success');
      }
    },
    onError: (error) => {
      showToast('Failed to start crawl', 'error');
      console.error('Crawl failed:', error);
    }
  });
}

// Upload document mutation
export function useUploadDocument() {
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ file, metadata }: { file: File, metadata: any }) => {
      return await knowledgeBaseService.uploadDocument(file, metadata);
    },
    onSuccess: (data) => {
      if (data.progressId) {
        showToast('Document upload started', 'success');
      }
    },
    onError: (error) => {
      showToast('Failed to upload document', 'error');
      console.error('Upload failed:', error);
    }
  });
}

// Stop crawl mutation
export function useStopCrawl() {
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async (progressId: string) => {
      return await knowledgeBaseService.stopCrawl(progressId);
    },
    onSuccess: () => {
      showToast('Crawl stopped', 'info');
    },
    onError: (error) => {
      showToast('Failed to stop crawl', 'error');
      console.error('Stop crawl failed:', error);
    }
  });
}

// Create group mutation
export function useCreateGroup() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: async ({ items, groupName }: { items: KnowledgeItem[], groupName: string }) => {
      const updatePromises = items.map(item =>
        knowledgeBaseService.updateKnowledgeItem(item.source_id, {
          metadata: {
            ...item.metadata,
            group_name: groupName
          }
        })
      );
      return await Promise.all(updatePromises);
    },
    onSuccess: (data, variables) => {
      // Invalidate the cache to refetch with new groups
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.items() });
      showToast(`Created group "${variables.groupName}" with ${variables.items.length} items`, 'success');
    },
    onError: (error) => {
      showToast('Failed to create group', 'error');
      console.error('Group creation failed:', error);
    }
  });
}

// Custom hook to manage crawl progress state
export function useCrawlProgressManager() {
  const [progressItems, setProgressItems] = useState<CrawlProgressData[]>([]);
  const queryClient = useQueryClient();

  // Load active crawls from localStorage on mount
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
            const isCompleted = ['completed', 'error', 'failed', 'cancelled'].includes(parsed.status);
            const now = Date.now();
            const startedAt = parsed.startedAt || now;
            const ageMinutes = (now - startedAt) / (1000 * 60);
            const isStale = ageMinutes > 5;
            
            if (isCompleted || isStale) {
              staleItems.push(crawlId);
            } else {
              restoredItems.push({
                ...parsed,
                progressId: crawlId,
              });
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
      
      // Set restored items
      if (restoredItems.length > 0) {
        setProgressItems(restoredItems);
      }
    }
  }, []);

  const addProgressItem = useCallback((item: CrawlProgressData) => {
    setProgressItems(prev => {
      const existing = prev.find(p => p.progressId === item.progressId);
      if (existing) {
        return prev.map(p => p.progressId === item.progressId ? item : p);
      }
      return [...prev, item];
    });

    // Store in localStorage
    localStorage.setItem(`crawl_progress_${item.progressId}`, JSON.stringify({
      ...item,
      startedAt: Date.now()
    }));
    
    const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
    if (!activeCrawls.includes(item.progressId)) {
      activeCrawls.push(item.progressId);
      localStorage.setItem('active_crawls', JSON.stringify(activeCrawls));
    }
  }, []);

  const removeProgressItem = useCallback((progressId: string) => {
    setProgressItems(prev => prev.filter(item => item.progressId !== progressId));
    
    // Clean up localStorage
    localStorage.removeItem(`crawl_progress_${progressId}`);
    const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
    const updated = activeCrawls.filter((id: string) => id !== progressId);
    localStorage.setItem('active_crawls', JSON.stringify(updated));
  }, []);

  const updateProgressItem = useCallback((progressId: string, updates: Partial<CrawlProgressData>) => {
    setProgressItems(prev => prev.map(item =>
      item.progressId === progressId ? { ...item, ...updates } : item
    ));
  }, []);

  const completeProgressItem = useCallback((progressId: string) => {
    removeProgressItem(progressId);
    // Invalidate knowledge items to show the new item
    queryClient.invalidateQueries({ queryKey: knowledgeKeys.items() });
  }, [removeProgressItem, queryClient]);

  return {
    progressItems,
    addProgressItem,
    removeProgressItem,
    updateProgressItem,
    completeProgressItem,
  };
}