import { useEffect, useRef, useState } from 'react';

/**
 * Custom hook for automatic terminal scrolling behavior
 * Automatically scrolls to bottom when dependencies change
 * BUT stops auto-scrolling when user manually scrolls up
 * 
 * @param dependencies - Array of dependencies that trigger scroll
 * @param enabled - Optional flag to enable/disable scrolling (default: true)
 * @returns ref to attach to the scrollable container
 */
export const useTerminalScroll = <T = any>(
  dependencies: T[], 
  enabled: boolean = true
) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if user is at bottom of scroll
  const isAtBottom = () => {
    if (!scrollContainerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Allow 50px threshold for "at bottom" detection
    return scrollHeight - scrollTop - clientHeight < 50;
  };

  // Handle user scroll events
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Clear any existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      // Check if user scrolled away from bottom
      if (!isAtBottom()) {
        setIsUserScrolling(true);
      }

      // Set timeout to re-enable auto-scroll if user returns to bottom
      scrollTimeoutRef.current = setTimeout(() => {
        if (isAtBottom()) {
          setIsUserScrolling(false);
        }
      }, 100);
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Auto-scroll effect
  useEffect(() => {
    if (scrollContainerRef.current && enabled && !isUserScrolling) {
      // Use requestAnimationFrame for smooth scrolling
      requestAnimationFrame(() => {
        if (scrollContainerRef.current && !isUserScrolling) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
    }
  // Use length of dependencies array instead of spreading to avoid React warnings
  }, [dependencies.length, enabled, isUserScrolling]);

  return scrollContainerRef;
}; 