import { useState, useCallback, useRef, useEffect } from 'react';

interface UseDatabaseMutationOptions<TData, TVariables> {
  onSuccess?: (data: TData) => void;
  onError?: (error: Error) => void;
  invalidateCache?: () => void;
  successMessage?: string;
  errorMessage?: string;
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
}

interface UseDatabaseMutationResult<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<void>;
  mutateAsync: (variables: TVariables) => Promise<TData>;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: Error | null;
  data: TData | undefined;
  reset: () => void;
}

/**
 * Database-first mutation hook with loading states and error handling
 * 
 * Features:
 * - Shows loading state during operation
 * - Waits for database confirmation before UI update
 * - Displays errors immediately for debugging
 * - Invalidates related queries after success
 * - NO optimistic updates
 */
export function useDatabaseMutation<TData = unknown, TVariables = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseDatabaseMutationOptions<TData, TVariables> = {}
): UseDatabaseMutationResult<TData, TVariables> {
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<TData | undefined>(undefined);
  
  // Track if component is still mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const {
    onSuccess,
    onError,
    invalidateCache,
    successMessage = 'Operation completed successfully',
    errorMessage = 'Operation failed',
    showSuccessToast = false,
    showErrorToast = true,
  } = options;

  const reset = useCallback(() => {
    if (isMountedRef.current) {
      setIsLoading(false);
      setIsError(false);
      setIsSuccess(false);
      setError(null);
      setData(undefined);
    }
  }, []);

  const mutateAsync = useCallback(async (variables: TVariables): Promise<TData> => {
    // Only update state if still mounted
    if (isMountedRef.current) {
      setIsLoading(true);
      setIsError(false);
      setIsSuccess(false);
      setError(null);
    }

    try {
      const result = await mutationFn(variables);
      
      // Only update state and call callbacks if still mounted
      if (isMountedRef.current) {
        setData(result);
        setIsSuccess(true);
        
        // Invalidate cache if specified
        if (invalidateCache) {
          invalidateCache();
        }

        // Call success callback if provided
        if (onSuccess) {
          onSuccess(result);
        }

        // Show success toast if enabled
        if (showSuccessToast && typeof window !== 'undefined' && (window as any).toast) {
          (window as any).toast.success(successMessage);
        }
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      
      // Only update state and call callbacks if still mounted
      if (isMountedRef.current) {
        setError(error);
        setIsError(true);

        // Call error callback if provided
        if (onError) {
          onError(error);
        }

        // Show error toast if enabled (default)
        if (showErrorToast && typeof window !== 'undefined' && (window as any).toast) {
          (window as any).toast.error(`${errorMessage}: ${error.message}`);
        }

        // Log for debugging in beta
        console.error('Database operation failed:', error);
      }

      throw error;
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [mutationFn, onSuccess, onError, invalidateCache, successMessage, errorMessage, showSuccessToast, showErrorToast]);

  const mutate = useCallback(async (variables: TVariables): Promise<void> => {
    try {
      await mutateAsync(variables);
    } catch {
      // Error already handled in mutateAsync
    }
  }, [mutateAsync]);

  return {
    mutate,
    mutateAsync,
    isLoading,
    isError,
    isSuccess,
    error,
    data,
    reset,
  };
}

/**
 * Hook for mutations with inline loading indicator
 */
export function useAsyncMutation<TData = unknown, TVariables = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>
) {
  const [isLoading, setIsLoading] = useState(false);
  
  // Track if component is still mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async (variables: TVariables): Promise<TData | undefined> => {
    if (isMountedRef.current) {
      setIsLoading(true);
    }
    try {
      const result = await mutationFn(variables);
      return result;
    } catch (error) {
      console.error('Async mutation failed:', error);
      throw error;
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [mutationFn]);

  return { execute, isLoading };
}