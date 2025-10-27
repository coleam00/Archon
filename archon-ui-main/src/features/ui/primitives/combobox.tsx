/**
 * ComboBox Primitive
 *
 * A searchable dropdown component built with Radix UI Popover
 * Provides autocomplete functionality with keyboard navigation
 * Follows WAI-ARIA combobox pattern for accessibility
 */

import * as Popover from "@radix-ui/react-popover";
import { Check, Loader2 } from "lucide-react";
import * as React from "react";
import { Button } from "./button";
import { cn } from "./styles";

export interface ComboBoxOption {
  value: string;
  label: string;
  description?: string;
}

interface ComboBoxProps {
  options: ComboBoxOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  isLoading?: boolean;
  allowCustomValue?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * ComboBox component with search and custom value support
 *
 * @example
 * <ComboBox
 *   options={[{ value: "1", label: "Option 1" }]}
 *   value={selected}
 *   onValueChange={setSelected}
 *   placeholder="Select..."
 *   allowCustomValue={true}
 * />
 */
export const ComboBox = React.forwardRef<HTMLButtonElement, ComboBoxProps>(
  (
    {
      options,
      value,
      onValueChange,
      placeholder = "Select option...",
      searchPlaceholder = "Search...",
      emptyMessage = "No results found.",
      className,
      disabled = false,
      isLoading = false,
      allowCustomValue = false,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
    },
    ref,
  ) => {
    // State management
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [highlightedIndex, setHighlightedIndex] = React.useState(0);

    // Refs for DOM elements
    const inputRef = React.useRef<HTMLInputElement>(null);
    const optionsRef = React.useRef<HTMLDivElement>(null);
    const listboxId = React.useId();

    // Memoized filtered options
    const filteredOptions = React.useMemo(() => {
      if (!search.trim()) return options;

      const searchLower = search.toLowerCase().trim();
      return options.filter(
        (option) =>
          option.label.toLowerCase().includes(searchLower) || option.value.toLowerCase().includes(searchLower),
      );
    }, [options, search]);

    // Derived state
    const selectedOption = React.useMemo(() => options.find((opt) => opt.value === value), [options, value]);
    const displayValue = selectedOption?.label || value || "";
    const hasCustomOption =
      allowCustomValue &&
      search.trim() &&
      !filteredOptions.some((opt) => opt.label.toLowerCase() === search.toLowerCase());

    // Event handlers
    const handleSelect = React.useCallback(
      (optionValue: string) => {
        onValueChange(optionValue);
        setOpen(false);
        setSearch("");
        setHighlightedIndex(0);
      },
      [onValueChange],
    );

    const handleCustomValue = React.useCallback(() => {
      if (hasCustomOption) {
        handleSelect(search.trim());
      }
    }, [hasCustomOption, search, handleSelect]);

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        switch (e.key) {
          case "Enter":
            e.preventDefault();
            if (filteredOptions.length > 0 && highlightedIndex < filteredOptions.length) {
              handleSelect(filteredOptions[highlightedIndex].value);
            } else if (hasCustomOption) {
              handleCustomValue();
            }
            break;
          case "ArrowDown":
            e.preventDefault();
            setHighlightedIndex((prev) => {
              const maxIndex = hasCustomOption ? filteredOptions.length : filteredOptions.length - 1;
              return Math.min(prev + 1, maxIndex);
            });
            break;
          case "ArrowUp":
            e.preventDefault();
            setHighlightedIndex((prev) => Math.max(prev - 1, 0));
            break;
          case "Escape":
            e.preventDefault();
            setOpen(false);
            break;
          case "Tab":
            // Allow natural tab behavior to close dropdown
            setOpen(false);
            break;
        }
      },
      [filteredOptions, highlightedIndex, hasCustomOption, handleSelect, handleCustomValue],
    );

    // Focus management
    React.useEffect(() => {
      if (open) {
        setSearch("");
        setHighlightedIndex(0);
        // Use RAF for more reliable focus
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      }
    }, [open]);

    // Scroll highlighted option into view
    React.useEffect(() => {
      if (open && optionsRef.current) {
        const highlightedElement = optionsRef.current.querySelector('[data-highlighted="true"]');
        highlightedElement?.scrollIntoView({ block: "nearest" });
      }
    }, [highlightedIndex, open]);

    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            disabled={disabled || isLoading}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Stop propagation to prevent parent handlers
              e.stopPropagation();
              // Allow Space to open the dropdown
              if (e.key === " ") {
                e.preventDefault();
                setOpen(true);
              }
              // Also open on Enter/ArrowDown for better keyboard UX
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
            className={cn(
              "h-auto px-2 py-1 rounded-md text-xs font-medium",
              "bg-gray-100/50 dark:bg-gray-800/50",
              "hover:bg-gray-200/50 dark:hover:bg-gray-700/50",
              "border border-gray-300/50 dark:border-gray-600/50",
              "transition-all duration-200",
              "focus:outline-none focus:ring-1 focus:ring-cyan-400",
              !displayValue && "text-gray-500 dark:text-gray-400",
              (disabled || isLoading) && "opacity-50 cursor-not-allowed",
              className,
            )}
          >
            <span className="truncate">
              {isLoading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Loading options...</span>
                  Loading...
                </span>
              ) : (
                displayValue || placeholder
              )}
            </span>
          </Button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            className={cn(
              "w-full min-w-[var(--radix-popover-trigger-width)] max-w-[320px]",
              "bg-gradient-to-b from-white/95 to-white/90",
              "dark:from-gray-900/95 dark:to-black/95",
              "backdrop-blur-xl",
              "border border-gray-200 dark:border-gray-700",
              "rounded-lg shadow-xl",
              "shadow-cyan-500/10 dark:shadow-cyan-400/10",
              "z-50",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            )}
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <div className="p-1">
              {/* Search Input */}
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label={ariaLabel ?? "Search options"}
                aria-labelledby={ariaLabelledBy}
                aria-describedby={ariaDescribedBy}
                aria-controls={listboxId}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-activedescendant={
                  open
                    ? hasCustomOption && highlightedIndex === filteredOptions.length
                      ? `${listboxId}-custom`
                      : highlightedIndex < filteredOptions.length
                        ? `${listboxId}-opt-${highlightedIndex}`
                        : undefined
                    : undefined
                }
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation(); // Stop propagation first
                  handleKeyDown(e);
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder={searchPlaceholder}
                className={cn(
                  "w-full px-2 py-1 text-xs",
                  "bg-white/50 dark:bg-black/50",
                  "border border-gray-200 dark:border-gray-700",
                  "rounded",
                  "text-gray-900 dark:text-white",
                  "placeholder-gray-500 dark:placeholder-gray-400",
                  "focus:outline-none focus:ring-1 focus:ring-cyan-400",
                  "transition-all duration-200",
                )}
              />

              {/* Options List */}
              <div
                ref={optionsRef}
                id={listboxId}
                role="listbox"
                aria-label="Options"
                className="mt-1 overflow-y-auto max-h-[150px]"
              >
                {isLoading ? (
                  <div className="py-3 text-center text-xs text-gray-500 dark:text-gray-400">
                    <Loader2 className="h-3 w-3 animate-spin mx-auto mb-1" aria-hidden="true" />
                    <span>Loading...</span>
                  </div>
                ) : filteredOptions.length === 0 && !hasCustomOption ? (
                  <div
                    className="py-3 text-center text-xs text-gray-500 dark:text-gray-400"
                    role="option"
                    aria-disabled="true"
                  >
                    {emptyMessage}
                  </div>
                ) : (
                  <>
                    {filteredOptions.map((option, index) => {
                      const isSelected = value === option.value;
                      const isHighlighted = highlightedIndex === index;

                      return (
                        <button
                          type="button"
                          key={option.value}
                          id={`${listboxId}-opt-${index}`}
                          role="option"
                          aria-selected={isSelected}
                          data-highlighted={isHighlighted}
                          onClick={() => handleSelect(option.value)}
                          onMouseEnter={() => setHighlightedIndex(index)}
                          className={cn(
                            "relative flex w-full items-center px-2 py-1.5",
                            "text-xs text-left",
                            "transition-colors duration-150",
                            "text-gray-900 dark:text-white",
                            "hover:bg-gray-100/80 dark:hover:bg-white/10",
                            "focus:outline-none focus:bg-gray-100/80 dark:focus:bg-white/10",
                            isSelected && "bg-cyan-50/50 dark:bg-cyan-900/20",
                            isHighlighted && !isSelected && "bg-gray-100/60 dark:bg-white/5",
                          )}
                        >
                          <Check
                            className={cn(
                              "mr-1.5 h-3 w-3 shrink-0",
                              isSelected ? "opacity-100 text-cyan-600 dark:text-cyan-400" : "opacity-0",
                            )}
                            aria-hidden="true"
                          />
                          <span className="truncate">{option.label}</span>
                        </button>
                      );
                    })}

                    {hasCustomOption && (
                      <button
                        type="button"
                        id={`${listboxId}-custom`}
                        role="option"
                        aria-selected={false}
                        data-highlighted={highlightedIndex === filteredOptions.length}
                        onClick={handleCustomValue}
                        onMouseEnter={() => setHighlightedIndex(filteredOptions.length)}
                        className={cn(
                          "relative flex w-full items-center px-2 py-1.5",
                          "text-xs text-left",
                          "bg-cyan-50/30 dark:bg-cyan-900/10",
                          "text-cyan-600 dark:text-cyan-400",
                          "border-t border-gray-200/50 dark:border-gray-700/50",
                          "hover:bg-cyan-100/50 dark:hover:bg-cyan-800/30",
                          "transition-colors duration-200",
                          highlightedIndex === filteredOptions.length && "bg-cyan-100/50 dark:bg-cyan-800/30",
                        )}
                      >
                        <span className="ml-4">Add "{search}"</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  },
);

ComboBox.displayName = "ComboBox";
