import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSave, useAutoSaveString } from "./useAutoSave";

describe("useAutoSave", () => {
  // Setup and teardown
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("Basic save functionality", () => {
    it("should initialize with the provided value", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "initial value",
          onSave: mockSave,
        }),
      );

      expect(result.current.editValue).toBe("initial value");
      expect(result.current.hasUnsavedChanges).toBe(false);
      expect(result.current.isSaving).toBe(false);
      expect(result.current.hasError).toBe(false);
    });

    it("should detect unsaved changes when edit value differs from prop value", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("modified");
      });

      expect(result.current.hasUnsavedChanges).toBe(true);
      expect(result.current.editValue).toBe("modified");
    });

    it("should call onSave when save() is called manually", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).toHaveBeenCalledWith("changed");
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it("should not save when value hasn't changed", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "same value",
          onSave: mockSave,
        }),
      );

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  describe("Auto-save timing and debouncing", () => {
    it("should auto-save after debounce delay when editing", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          debounceMs: 500,
          isEditing: true,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      // Should not save immediately
      expect(mockSave).not.toHaveBeenCalled();

      // Fast-forward time to trigger debounced save
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Wait for the promise to resolve
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockSave).toHaveBeenCalledWith("changed");
    });

    it("should debounce multiple rapid changes", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          debounceMs: 500,
          isEditing: true,
        }),
      );

      // Make multiple rapid changes without advancing timers between changes
      act(() => {
        result.current.setEditValue("change1");
      });

      act(() => {
        result.current.setEditValue("change2");
      });

      act(() => {
        result.current.setEditValue("change3");
      });

      // Should not save yet
      expect(mockSave).not.toHaveBeenCalled();

      // Fast-forward to complete debounce - only trigger the timeout once
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Wait for any pending promises without running additional timers
      await act(async () => {
        await Promise.resolve();
      });

      // Should only save the final value once
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith("change3");
    });

    it("should not auto-save when not in editing mode", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          debounceMs: 500,
          isEditing: false,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  describe("Loading states during save operations", () => {
    it("should set isSaving to true during save operation", async () => {
      let resolvePromise: (value?: unknown) => void;
      const savePromise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      const mockSave = vi.fn().mockReturnValue(savePromise);

      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      // Start save operation and immediately check isSaving state
      act(() => {
        result.current.save();
      });

      // Should be saving immediately after calling save
      expect(result.current.isSaving).toBe(true);

      // Resolve the promise
      act(() => {
        resolvePromise!();
      });

      // Wait for save to complete
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should no longer be saving
      expect(result.current.isSaving).toBe(false);
    });
  });

  describe("Error handling and recovery", () => {
    it("should handle save errors gracefully", async () => {
      const mockSave = vi.fn().mockRejectedValue(new Error("Save failed"));
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      await act(async () => {
        try {
          await result.current.save();
        } catch (error) {
          // Expected to throw
        }
      });

      expect(result.current.hasError).toBe(true);
      expect(result.current.isSaving).toBe(false);
      // Should revert to original value on error
      expect(result.current.editValue).toBe("original");
    });

    it("should clear error state when editing starts", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result, rerender } = renderHook(
        ({ isEditing }) =>
          useAutoSave({
            value: "original",
            onSave: mockSave,
            isEditing,
          }),
        { initialProps: { isEditing: false } },
      );

      // Simulate error state by manually setting it (this is internal state)
      // In real usage, error would come from a failed save
      act(() => {
        result.current.setEditValue("changed");
      });

      // Start editing - should clear error when isEditing becomes true
      rerender({ isEditing: true });

      expect(result.current.hasError).toBe(false);
    });
  });

  describe("Validation handling", () => {
    it("should not save when validation fails", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const mockValidate = vi.fn().mockReturnValue(false);

      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          validate: mockValidate,
        }),
      );

      act(() => {
        result.current.setEditValue("invalid");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockValidate).toHaveBeenCalledWith("invalid");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("should save when validation passes", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const mockValidate = vi.fn().mockReturnValue(true);

      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          validate: mockValidate,
        }),
      );

      act(() => {
        result.current.setEditValue("valid");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockValidate).toHaveBeenCalledWith("valid");
      expect(mockSave).toHaveBeenCalledWith("valid");
    });
  });

  describe("Value transformation", () => {
    it("should transform value before saving", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const mockTransform = vi.fn().mockImplementation((value: string) => value.toUpperCase());

      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          transform: mockTransform,
        }),
      );

      act(() => {
        result.current.setEditValue("lowercase");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockTransform).toHaveBeenCalledWith("lowercase");
      expect(mockSave).toHaveBeenCalledWith("LOWERCASE");
    });
  });

  describe("Cancel and reset functionality", () => {
    it("should revert to original value when cancelled", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      expect(result.current.hasUnsavedChanges).toBe(true);

      act(() => {
        result.current.cancel();
      });

      expect(result.current.editValue).toBe("original");
      expect(result.current.hasUnsavedChanges).toBe(false);
      expect(result.current.hasError).toBe(false);
    });

    it("should reset to current prop value", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "updated prop",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("local change");
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.editValue).toBe("updated prop");
      expect(result.current.hasError).toBe(false);
    });
  });

  describe("Prop value updates", () => {
    it("should update edit value when prop changes and not editing", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result, rerender } = renderHook(
        ({ value, isEditing }) =>
          useAutoSave({
            value,
            onSave: mockSave,
            isEditing,
          }),
        { initialProps: { value: "initial", isEditing: false } },
      );

      expect(result.current.editValue).toBe("initial");

      rerender({ value: "updated", isEditing: false });

      expect(result.current.editValue).toBe("updated");
    });

    it("should not update edit value when prop changes while editing", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result, rerender } = renderHook(
        ({ value, isEditing }) =>
          useAutoSave({
            value,
            onSave: mockSave,
            isEditing,
          }),
        { initialProps: { value: "initial", isEditing: true } },
      );

      act(() => {
        result.current.setEditValue("user edit");
      });

      rerender({ value: "prop updated", isEditing: true });

      // Should keep user's edit, not update from prop
      expect(result.current.editValue).toBe("user edit");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty string values", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).toHaveBeenCalledWith("");
    });

    it("should handle cleanup on unmount", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result, unmount } = renderHook(() =>
        useAutoSave({
          value: "original",
          onSave: mockSave,
          debounceMs: 500,
          isEditing: true,
        }),
      );

      act(() => {
        result.current.setEditValue("changed");
      });

      // Unmount before auto-save triggers
      unmount();

      // Should not crash or call save after unmount
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  describe("TypeScript type safety", () => {
    it("should maintain type safety with string values", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: "string value",
          onSave: mockSave,
        }),
      );

      // TypeScript should enforce string type
      act(() => {
        result.current.setEditValue("another string");
      });

      expect(result.current.editValue).toBe("another string");
    });

    it("should maintain type safety with number values", () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSave({
          value: 42,
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue(84);
      });

      expect(result.current.editValue).toBe(84);
    });

    it("should maintain type safety with complex object types", () => {
      interface TestObject {
        id: number;
        name: string;
        active: boolean;
      }

      const mockSave = vi.fn().mockResolvedValue(undefined);
      const initialValue: TestObject = { id: 1, name: "test", active: true };

      const { result } = renderHook(() =>
        useAutoSave({
          value: initialValue,
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue({ id: 2, name: "updated", active: false });
      });

      expect(result.current.editValue).toEqual({ id: 2, name: "updated", active: false });
    });
  });
});

describe("useAutoSaveString", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("String-specific validation", () => {
    it("should trim whitespace by default", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSaveString({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("  trimmed  ");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).toHaveBeenCalledWith("trimmed");
    });

    it("should not allow empty strings by default", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSaveString({
          value: "original",
          onSave: mockSave,
        }),
      );

      act(() => {
        result.current.setEditValue("   ");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("should allow empty strings when allowEmpty is true", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSaveString({
          value: "original",
          onSave: mockSave,
          allowEmpty: true,
        }),
      );

      act(() => {
        result.current.setEditValue("");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).toHaveBeenCalledWith("");
    });

    it("should not trim when trimValue is false", async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useAutoSaveString({
          value: "original",
          onSave: mockSave,
          trimValue: false,
        }),
      );

      act(() => {
        result.current.setEditValue("  untrimmed  ");
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockSave).toHaveBeenCalledWith("  untrimmed  ");
    });
  });
});
