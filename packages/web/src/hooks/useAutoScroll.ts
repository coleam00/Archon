import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';

export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  dependencies: unknown[],
  /** When this value changes, force-scroll to bottom regardless of user scroll position. */
  forceTrigger?: number
): {
  isAtBottom: boolean;
  scrollToBottom: () => void;
} {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledUpRef = useRef(false);
  const prevForceTriggerRef = useRef(forceTrigger);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userScrolledUpRef.current = false;
      setIsAtBottom(true);
    }
  }, [containerRef]);

  // Detect user scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = (): void => {
      const threshold = 50;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
      userScrolledUpRef.current = !atBottom;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return (): void => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  // Auto-scroll when dependencies change (new messages)
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      scrollToBottom();
    }
  }, dependencies);

  // Force-scroll when trigger changes (e.g., workflow completion)
  useEffect(() => {
    if (forceTrigger !== undefined && forceTrigger !== prevForceTriggerRef.current) {
      prevForceTriggerRef.current = forceTrigger;
      // Small delay to let the final content render before scrolling
      setTimeout(scrollToBottom, 100);
    }
  }, [forceTrigger, scrollToBottom]);

  return { isAtBottom, scrollToBottom };
}
