import { useState, useCallback, useRef, useEffect } from 'react';
import { useToast } from '../contexts/ToastContext';

interface UseProjectMutationOptions<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error) => void;
  successMessage?: string;
  errorMessage?: string;
}

interface UseProjectMutationResult<TData, TVariables> {
  mutate: (variables: TVariables) => Promise<void>;
  mutateAsync: (variables: TVariables) => Promise<TData>;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: Error | null;
  data: TData | undefined;
}

/**
 * Project-specific mutation hook
 * Similar to useDatabaseMutation but tailored for project operations
 */
export function useProjectMutation<TData = unknown, TVariables = unknown>(
  _key: unknown, // For compatibility with old API, not used
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseProjectMutationOptions<TData, TVariables> = {}
): UseProjectMutationResult<TData, TVariables> {
  const { showToast } = useToast();
  const [isPending, setIsPending] = useState(false);
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
    successMessage = 'Operation completed successfully',
    errorMessage = 'Operation failed',
  } = options;

  const mutateAsync = useCallback(async (variables: TVariables): Promise<TData> => {
    // Only update state if still mounted
    if (isMountedRef.current) {
      setIsPending(true);
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

        // Call success callback if provided
        if (onSuccess) {
          onSuccess(result, variables);
        }

        // Show success message if available
        if (successMessage) {
          showToast(successMessage, 'success');
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

        // Show error message
        showToast(errorMessage, 'error');
      }

      throw error;
    } finally {
      if (isMountedRef.current) {
        setIsPending(false);
      }
    }
  }, [mutationFn, onSuccess, onError, successMessage, errorMessage]);

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
    isPending,
    isError,
    isSuccess,
    error,
    data,
  };
}