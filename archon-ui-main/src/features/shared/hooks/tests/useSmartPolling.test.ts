import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSmartPolling } from "../useSmartPolling";

describe("useSmartPolling", () => {
  beforeEach(() => {
    // Reset document visibility state
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      value: false,
      writable: true,
      configurable: true,
    });
    // Mock document.hasFocus
    document.hasFocus = vi.fn(() => true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
  });

  it("should return the base interval when document is visible and focused", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    expect(result.current.refetchInterval).toBe(5000);
    expect(result.current.isActive).toBe(true);
    expect(result.current.isVisible).toBe(true);
    expect(result.current.hasFocus).toBe(true);
  });

  it("should disable polling when document is hidden", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    // Initially should be active
    expect(result.current.isActive).toBe(true);
    expect(result.current.refetchInterval).toBe(5000);

    // Simulate tab becoming hidden
    act(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Should be disabled (returns false)
    expect(result.current.isVisible).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.refetchInterval).toBe(false);
  });

  it("should resume polling when document becomes visible again", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    // Make hidden
    act(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.refetchInterval).toBe(false);

    // Make visible again
    act(() => {
      Object.defineProperty(document, "hidden", {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.isVisible).toBe(true);
    expect(result.current.isActive).toBe(true);
    expect(result.current.refetchInterval).toBe(5000);
  });

  it("should slow down when window loses focus", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    // Initially focused
    expect(result.current.refetchInterval).toBe(5000);
    expect(result.current.hasFocus).toBe(true);

    // Simulate window blur
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // Should be slowed down - 5000 * 1.5 = 7500, but min 5000, so 7500
    expect(result.current.hasFocus).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.refetchInterval).toBe(7500);
  });

  it("should resume normal speed when window regains focus", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    // Blur window
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current.refetchInterval).toBe(7500);

    // Focus window again
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.hasFocus).toBe(true);
    expect(result.current.isActive).toBe(true);
    expect(result.current.refetchInterval).toBe(5000);
  });

  it("should handle different base intervals with dynamic background polling", () => {
    const { result: result1 } = renderHook(() => useSmartPolling(1000));
    const { result: result2 } = renderHook(() => useSmartPolling(10000));

    expect(result1.current.refetchInterval).toBe(1000);
    expect(result2.current.refetchInterval).toBe(10000);

    // When blurred, should use 1.5x base with 5s minimum
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result1.current.refetchInterval).toBe(5000); // 1000 * 1.5 = 1500, min 5000 = 5000
    expect(result2.current.refetchInterval).toBe(15000); // 10000 * 1.5 = 15000
  });

  it("should use default interval of 10000ms when not specified", () => {
    const { result } = renderHook(() => useSmartPolling());

    expect(result.current.refetchInterval).toBe(10000);
  });

  it("should ensure background polling is always slower than foreground", () => {
    // Test edge cases where old logic would fail
    const testCases = [
      { base: 1000, expectedBackground: 5000 }, // Minimum kicks in
      { base: 2000, expectedBackground: 5000 }, // Minimum kicks in
      { base: 4000, expectedBackground: 6000 }, // 1.5x base
      { base: 5000, expectedBackground: 7500 }, // 1.5x base
      { base: 10000, expectedBackground: 15000 }, // 1.5x base
    ];

    testCases.forEach(({ base, expectedBackground }) => {
      const { result } = renderHook(() => useSmartPolling(base));

      // Foreground should use base interval
      expect(result.current.refetchInterval).toBe(base);

      // Background should be slower
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(result.current.refetchInterval).toBe(expectedBackground);
      expect(result.current.refetchInterval).toBeGreaterThan(base);

      // Cleanup for next iteration
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    });
  });

  it("should cleanup event listeners on unmount", () => {
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const windowRemoveEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useSmartPolling(5000));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith("blur", expect.any(Function));

    removeEventListenerSpy.mockRestore();
    windowRemoveEventListenerSpy.mockRestore();
  });

  it("should correctly report isActive state", () => {
    const { result } = renderHook(() => useSmartPolling(5000));

    // Active when both visible and focused
    expect(result.current.isActive).toBe(true);

    // Not active when not focused
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.isActive).toBe(false);

    // Not active when hidden
    act(() => {
      window.dispatchEvent(new Event("focus")); // Focus first
      Object.defineProperty(document, "hidden", {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.isActive).toBe(false);
  });
});
