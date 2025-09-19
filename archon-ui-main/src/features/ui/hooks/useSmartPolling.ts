import { useEffect, useState } from "react";

/**
 * Smart polling hook that adjusts interval based on page visibility and focus
 *
 * Behavior:
 * - Hidden: Disables polling (returns false)
 * - Visible but unfocused: Polls at 1.5x base interval (min 5s) for background polling
 * - Visible and focused: Polls at base interval for active use
 *
 * Ensures background polling is always slower than foreground to reduce API load
 */
export function useSmartPolling(baseInterval: number = 10000) {
  const [isVisible, setIsVisible] = useState(true);
  const [hasFocus, setHasFocus] = useState(true);

  useEffect(() => {
    // Guard against SSR and non-browser environments
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    const handleFocus = () => setHasFocus(true);
    const handleBlur = () => setHasFocus(false);

    // Set initial state
    setIsVisible(!document.hidden);
    setHasFocus(document.hasFocus());

    // Add event listeners
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      // Cleanup with same guards
      if (typeof document !== "undefined" && typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("focus", handleFocus);
        window.removeEventListener("blur", handleBlur);
      }
    };
  }, []);

  // Calculate smart interval based on visibility and focus
  const getSmartInterval = (): number | false => {
    if (!isVisible) {
      // Page is hidden - disable polling
      return false;
    }

    if (!hasFocus) {
      // Page is visible but not focused - poll slower than active
      // Use 1.5x base interval with a minimum of 5s to ensure background is always slower
      return Math.max(baseInterval * 1.5, 5000);
    }

    // Page is active - use normal interval
    return baseInterval;
  };

  return {
    refetchInterval: getSmartInterval(),
    isActive: isVisible && hasFocus,
    isVisible,
    hasFocus,
  };
}
