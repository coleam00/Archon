/**
 * Centralized clipboard utilities for Archon V2 Alpha
 * 
 * Provides a robust clipboard API with automatic fallbacks and unmount-safe timers.
 * Uses modern Clipboard API when available, falls back to document.execCommand.
 */

import React, { useCallback, useRef, useEffect, useState } from 'react';

export interface ClipboardOptions {
  /** Success message to show (optional) */
  successMessage?: string;
  /** Error message to show (optional) */
  errorMessage?: string;
  /** Toast function to call on success/error */
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
  /** Reset timer duration in milliseconds (default: 2000) */
  resetDelay?: number;
}

export interface ClipboardResult {
  /** Whether the copy operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Copy text to clipboard using the best available method
 * 
 * @param text - Text to copy to clipboard
 * @param options - Optional configuration
 * @returns Promise with operation result
 */
export async function copyToClipboard(
  text: string, 
  options?: ClipboardOptions
): Promise<ClipboardResult> {
  const { successMessage, errorMessage, showToast } = options || {};

  try {
    // Primary method: Modern Clipboard API
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      if (showToast && successMessage) {
        showToast(successMessage, 'success');
      }
      return { success: true };
    }

    // Fallback method: document.execCommand (deprecated but widely supported)
    const result = await fallbackCopyToClipboard(text);
    if (result.success) {
      if (showToast && successMessage) {
        showToast(successMessage, 'success');
      }
      return result;
    }

    // If we reach here, both methods failed
    throw new Error(result.error || 'All clipboard methods failed');

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown clipboard error';
    
    if (showToast) {
      const message = errorMessage || 'Failed to copy to clipboard';
      showToast(message, 'error');
    }

    return {
      success: false,
      error: errorMsg
    };
  }
}

/**
 * Fallback clipboard copy using document.execCommand
 * 
 * @param text - Text to copy
 * @returns Promise with operation result
 */
async function fallbackCopyToClipboard(text: string): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    // Create temporary textarea element
    const textArea = document.createElement('textarea');
    textArea.value = text;
    
    // Style to make it invisible and non-disruptive
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    textArea.setAttribute('aria-hidden', 'true');
    textArea.setAttribute('tabindex', '-1');

    try {
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      // Try to copy using execCommand
      const successful = document.execCommand('copy');
      
      if (successful) {
        resolve({ success: true });
      } else {
        resolve({ 
          success: false, 
          error: 'document.execCommand failed' 
        });
      }
    } catch (error) {
      resolve({ 
        success: false, 
        error: error instanceof Error ? error.message : 'execCommand threw error' 
      });
    } finally {
      // Clean up the temporary element
      if (document.body.contains(textArea)) {
        document.body.removeChild(textArea);
      }
    }
  });
}

/**
 * React hook for clipboard operations with unmount-safe state management
 * 
 * @param options - Configuration options
 * @returns Object with copy function and state
 */
export function useClipboard(options?: ClipboardOptions) {
  const { resetDelay = 2000 } = options || {};
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Track component mount state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Clean up any pending timers on unmount
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string, customOptions?: ClipboardOptions): Promise<ClipboardResult> => {
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Merge options
      const mergedOptions = { ...options, ...customOptions };
      
      // Perform the copy operation
      const result = await copyToClipboard(text, mergedOptions);

      // Set up reset timer if component is still mounted
      if (mountedRef.current && resetDelay > 0) {
        timeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            // Reset any visual feedback here if needed
            // This is where consumers can hook into reset logic
          }
          timeoutRef.current = null;
        }, resetDelay);
      }

      return result;
    },
    [options, resetDelay]
  );

  return {
    copy,
    /**
     * Manually clear any pending reset timers
     */
    clearTimeout: useCallback(() => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }, [])
  };
}

/**
 * React hook for clipboard operations with visual state feedback
 * 
 * @param options - Configuration options
 * @returns Object with copy function and feedback state
 */
export function useClipboardWithFeedback(options?: ClipboardOptions) {
  const { resetDelay = 2000 } = options || {};
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Track component mount state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string, customOptions?: ClipboardOptions): Promise<ClipboardResult> => {
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      const mergedOptions = { ...options, ...customOptions };
      const result = await copyToClipboard(text, mergedOptions);

      if (result.success && mountedRef.current) {
        setCopied(true);

        // Set up reset timer
        if (resetDelay > 0) {
          timeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              setCopied(false);
            }
            timeoutRef.current = null;
          }, resetDelay);
        }
      }

      return result;
    },
    [options, resetDelay]
  );

  return {
    copy,
    copied,
    /**
     * Manually reset the copied state
     */
    reset: useCallback(() => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (mountedRef.current) {
        setCopied(false);
      }
    }, [])
  };
}

