import { useEffect, useState } from "react";

/**
 * Smart polling hook that adjusts interval based on page visibility and focus
 *
 * Reduces unnecessary API calls when user is not actively using the app
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
      // Page is visible but not focused - poll less frequently
      return 5000; // 5 seconds for background polling (aligned with polling guidelines)
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
