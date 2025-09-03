import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

interface UsePollingOptions<T> {
  interval?: number;
  enabled?: boolean;
  onError?: (error: Error) => void;
  onSuccess?: (data: T) => void;
  staleTime?: number;
}

interface UsePollingResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => Promise<void>;
}

/**
 * Generic polling hook with visibility and focus detection
 * 
 * Features:
 * - Stops polling when tab is hidden
 * - Resumes polling when tab becomes visible
 * - Immediate refetch on focus
 * - ETag support for efficient polling
 */
export function usePolling<T>(
  url: string,
  options: UsePollingOptions<T> = {}
): UsePollingResult<T> {
  const { 
    interval = 3000, 
    enabled = true, 
    onError, 
    onSuccess,
    staleTime = 0
  } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pollInterval, setPollInterval] = useState(enabled ? interval : 0);
  
  const etagRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cachedDataRef = useRef<T | undefined>(undefined);
  const lastFetchRef = useRef<number>(0);
  const notFoundCountRef = useRef<number>(0);  // Track consecutive 404s

  // Reset ETag/cache on URL change to avoid cross-endpoint contamination
  useEffect(() => {
    etagRef.current = null;
    cachedDataRef.current = undefined;
    lastFetchRef.current = 0;
  }, [url]);

  const fetchData = useCallback(async (force = false) => {
    // Don't fetch if URL is empty
    if (!url) {
      return;
    }
    
    // Check stale time
    if (!force && staleTime > 0 && Date.now() - lastFetchRef.current < staleTime) {
      return; // Data is still fresh
    }

    try {
      const headers: HeadersInit = {
        Accept: 'application/json',
      };

      // Include ETag if we have one for this URL (unless forcing refresh)
      if (etagRef.current && !force) {
        headers['If-None-Match'] = etagRef.current;
      }

      const response = await fetch(url, { 
        method: 'GET',
        headers,
        credentials: 'include',
      });

      // Handle 304 Not Modified - data hasn't changed
      if (response.status === 304) {
        // Return cached data
        if (cachedDataRef.current !== undefined) {
          setData(cachedDataRef.current);
          if (onSuccess) {
            onSuccess(cachedDataRef.current);
          }
        }
        // Update fetch time to respect staleTime
        lastFetchRef.current = Date.now();
        return;
      }

      if (!response.ok) {
        // For 404s, track consecutive failures
        if (response.status === 404) {
          notFoundCountRef.current++;
          
          // After 5 consecutive 404s (5 seconds), stop polling and call error handler
          if (notFoundCountRef.current >= 5) {
            console.error(`Resource permanently not found after ${notFoundCountRef.current} attempts: ${url}`);
            const error = new Error('Resource no longer exists');
            setError(error);
            setPollInterval(0); // Stop polling
            if (onError) {
              onError(error);
            }
            return;
          }
          
          console.log(`Resource not found (404), attempt ${notFoundCountRef.current}/5: ${url}`);
          lastFetchRef.current = Date.now();
          setError(null);
          return;
        }
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }
      
      // Reset 404 counter on successful response
      notFoundCountRef.current = 0;

      // Store ETag for next request
      const etag = response.headers.get('ETag');
      if (etag) {
        etagRef.current = etag;
      }

      const jsonData = await response.json();
      setData(jsonData);
      cachedDataRef.current = jsonData;
      lastFetchRef.current = Date.now();
      setError(null);
      
      // Call success callback if provided
      if (onSuccess) {
        onSuccess(jsonData);
      }
    } catch (err) {
      console.error('Polling error:', err);
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      if (onError) {
        onError(error);
      }
    } finally {
      setIsLoading(false);
    }
  }, [url, staleTime, onSuccess, onError]);

  // Handle visibility change
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setPollInterval(0); // Stop polling when hidden
      } else {
        setPollInterval(interval); // Resume polling when visible
        // Trigger immediate refetch if URL exists
        if (url && enabled) {
          fetchData();
        }
      }
    };

    const handleFocus = () => {
      // Immediate refetch on focus if URL exists
      if (url && enabled) {
        fetchData();
      }
      setPollInterval(interval);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [interval, fetchData, url, enabled]);

  // Update polling interval when enabled changes
  useEffect(() => {
    setPollInterval(enabled && !document.hidden ? interval : 0);
  }, [enabled, interval]);

  // Set up polling
  useEffect(() => {
    if (!url || !enabled) return;

    // Initial fetch
    fetchData();

    // Clear existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Set up new interval if polling is enabled
    if (pollInterval > 0) {
      intervalRef.current = setInterval(fetchData, pollInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [url, pollInterval, enabled, fetchData]);

  return {
    data,
    error,
    isLoading,
    isError: !!error,
    isSuccess: !isLoading && !error && data !== undefined,
    refetch: () => fetchData(true)
  };
}

/**
 * Hook for polling task updates
 */
export function useTaskPolling(projectId: string, options?: UsePollingOptions<any>) {
  const baseUrl = '/api/projects';
  const url = `${baseUrl}/${projectId}/tasks`;
  
  return usePolling(url, {
    interval: 8000, // 8 seconds for tasks
    staleTime: 2000, // Consider data stale after 2 seconds
    ...options,
  });
}

/**
 * Hook for polling project list
 */
export function useProjectPolling(options?: UsePollingOptions<any>) {
  const url = '/api/projects';
  
  return usePolling(url, {
    interval: 10000, // 10 seconds for project list
    staleTime: 3000, // Consider data stale after 3 seconds
    ...options,
  });
}


/**
 * Hook for polling crawl progress updates
 */
export function useCrawlProgressPolling(progressId: string | null, options?: UsePollingOptions<any>) {
  const url = progressId ? `/api/progress/${progressId}` : '';
  
  console.log(`🔍 useCrawlProgressPolling called with progressId: ${progressId}, url: ${url}`);
  
  // Track if crawl is complete to disable polling
  const [isComplete, setIsComplete] = useState(false);
  
  // Reset complete state when progressId changes
  useEffect(() => {
    console.log(`📊 Progress ID changed to: ${progressId}, resetting complete state`);
    setIsComplete(false);
  }, [progressId]);
  
  // Memoize the error handler to prevent recreating it on every render
  const handleError = useCallback((error: Error) => {
    // Handle permanent resource not found (after 5 consecutive 404s)
    if (error.message === 'Resource no longer exists') {
      console.log(`Crawl progress no longer exists for: ${progressId}`);
      
      // Clean up from localStorage
      if (progressId) {
        localStorage.removeItem(`crawl_progress_${progressId}`);
        const activeCrawls = JSON.parse(localStorage.getItem('active_crawls') || '[]');
        const updated = activeCrawls.filter((id: string) => id !== progressId);
        localStorage.setItem('active_crawls', JSON.stringify(updated));
      }
      
      // Pass error to parent if provided
      options?.onError?.(error);
      return;
    }
    
    // Log other errors
    if (!error.message.includes('404') && !error.message.includes('Not Found') && 
        !error.message.includes('ERR_INSUFFICIENT_RESOURCES')) {
      console.error('Crawl progress error:', error);
    }
    
    // Pass error to parent if provided
    options?.onError?.(error);
  }, [progressId, options]);
  
  const result = usePolling(url, {
    interval: 1000, // 1 second for crawl progress
    enabled: !!progressId && !isComplete,
    staleTime: 0, // Always refetch progress
    onError: handleError,
  });

  // Stop polling when operation is complete or failed
  useEffect(() => {
    const status = result.data?.status;
    if (result.data) {
      console.debug('🔄 Crawl polling data received:', { 
        progressId, 
        status, 
        progress: result.data.progress 
      });
    }
    if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
      console.debug('⏹️ Crawl polling stopping - status:', status);
      setIsComplete(true);
    }
  }, [result.data?.status, progressId]);

  // Backend now returns flattened, camelCase response - no transformation needed!
  const transformedData = result.data ? {
    ...result.data,
    // Ensure we have required fields with defaults
    progress: result.data.progress || 0,
    logs: result.data.logs || [],
    message: result.data.message || '',
  } : null;

  return {
    ...result,
    data: transformedData,
    isComplete
  };
}