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

  const fetchData = useCallback(async () => {
    // Don't fetch if URL is empty
    if (!url) {
      return;
    }
    
    // Check stale time
    if (staleTime > 0 && Date.now() - lastFetchRef.current < staleTime) {
      return; // Data is still fresh
    }

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      // Include ETag if we have one for this URL
      if (etagRef.current) {
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
        // For 404s, don't throw an error - just continue polling
        // This can happen briefly during initialization
        if (response.status === 404) {
          console.log(`Resource not found (404), will retry: ${url}`);
          return;
        }
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

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
    refetch: fetchData
  };
}

/**
 * Hook for polling task updates
 */
export function useTaskPolling(projectId: string, options?: UsePollingOptions<any>) {
  const baseUrl = '/api/projects';
  const url = `${baseUrl}/${projectId}/tasks`;
  
  return usePolling(url, {
    interval: 3000, // 3 seconds for tasks
    staleTime: 1000, // Consider data stale after 1 second
    ...options,
  });
}

/**
 * Hook for polling project list
 */
export function useProjectPolling(options?: UsePollingOptions<any>) {
  const url = '/api/projects';
  
  return usePolling(url, {
    interval: 5000, // 5 seconds for project list
    staleTime: 2000, // Consider data stale after 2 seconds
    ...options,
  });
}


/**
 * Hook for polling crawl progress updates
 */
export function useCrawlProgressPolling(progressId: string | null, options?: UsePollingOptions<any>) {
  const url = progressId ? `/api/crawl-progress/${progressId}` : '';
  
  // Track if crawl is complete to disable polling
  const [isComplete, setIsComplete] = useState(false);
  
  // Reset complete state when progressId changes
  useEffect(() => {
    setIsComplete(false);
  }, [progressId]);
  
  // Memoize the error handler to prevent recreating it on every render
  const handleError = useCallback((error: Error) => {
    if (!error.message.includes('404') && !error.message.includes('Not Found') && 
        !error.message.includes('ERR_INSUFFICIENT_RESOURCES')) {
      console.error('Crawl progress error:', error);
    }
  }, []);
  
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
      console.log('🔄 Crawl polling data received:', { 
        progressId, 
        status, 
        progress: result.data.progress 
      });
    }
    if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
      console.log('⏹️ Crawl polling stopping - status:', status);
      setIsComplete(true);
    }
  }, [result.data?.status, progressId]);

  return result;
}