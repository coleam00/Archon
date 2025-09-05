/**
 * ComboBox Primitive
 *
 * A searchable dropdown component built with Radix UI Popover and Command
 * Provides autocomplete functionality with keyboard navigation
 */

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
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
  isLoading?: boolean;
  allowCustomValue?: boolean;
}

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
      isLoading = false,
      allowCustomValue = false,
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const inputRef = React.useRef<HTMLInputElement>(null);

    // Filter options based on search
    const filteredOptions = React.useMemo(() => {
      if (!search) return options;

      const searchLower = search.toLowerCase();
      return options.filter(
        (option) =>
          option.label.toLowerCase().includes(searchLower) ||
          option.value.toLowerCase().includes(searchLower) ||
          option.description?.toLowerCase().includes(searchLower),
      );
    }, [options, search]);

    // Find current option label
    const selectedOption = options.find((opt) => opt.value === value);
    const displayValue = selectedOption?.label || value || "";

    // Handle selection
    const handleSelect = (optionValue: string) => {
      onValueChange(optionValue);
      setOpen(false);
      setSearch("");
    };

    // Handle custom value input
    const handleCustomValue = () => {
      if (allowCustomValue && search && !filteredOptions.some((opt) => opt.label === search)) {
        onValueChange(search);
        setOpen(false);
        setSearch("");
      }
    };

    // Focus input when opening
    React.useEffect(() => {
      if (open && inputRef.current) {
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    }, [open]);

    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            ref={ref}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "w-full justify-between font-normal",
              !displayValue && "text-gray-500 dark:text-gray-400",
              className,
            )}
          >
            <span className="truncate">
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading...
                </span>
              ) : (
                displayValue || placeholder
              )}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={cn(
              "w-full min-w-[var(--radix-popover-trigger-width)] max-h-[300px] p-1",
              "bg-gradient-to-b from-white/95 to-white/90",
              "dark:from-gray-900/95 dark:to-black/95",
              "backdrop-blur-xl",
              "border border-gray-200 dark:border-gray-700",
              "rounded-lg shadow-xl",
              "shadow-cyan-500/10 dark:shadow-cyan-400/10",
              "z-50",
            )}
            align="start"
            sideOffset={4}
          >
            {/* Search Input */}
            <div className="p-2">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allowCustomValue && search) {
                    e.preventDefault();
                    handleCustomValue();
                  }
                }}
                placeholder={searchPlaceholder}
                className={cn(
                  "w-full px-3 py-1.5 text-sm",
                  "bg-white/50 dark:bg-black/50",
                  "border border-gray-200 dark:border-gray-700",
                  "rounded-md",
                  "text-gray-900 dark:text-white",
                  "placeholder-gray-500 dark:placeholder-gray-400",
                  "focus:outline-none focus:border-cyan-400",
                  "focus:shadow-[0_0_10px_rgba(34,211,238,0.2)]",
                  "transition-all duration-200",
                )}
              />
            </div>

            {/* Options List */}
            <div className="overflow-y-auto max-h-[200px] p-1">
              {isLoading ? (
                <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                  Loading options...
                </div>
              ) : filteredOptions.length === 0 ? (
                <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  {emptyMessage}
                  {allowCustomValue && search && (
                    <button
                      type="button"
                      onClick={handleCustomValue}
                      className={cn(
                        "mt-2 block w-full",
                        "px-3 py-1.5 text-left text-sm",
                        "bg-cyan-50/50 dark:bg-cyan-900/20",
                        "text-cyan-600 dark:text-cyan-400",
                        "rounded-md",
                        "hover:bg-cyan-100/50 dark:hover:bg-cyan-800/30",
                        "transition-colors duration-200",
                      )}
                    >
                      Create "{search}"
                    </button>
                  )}
                </div>
              ) : (
                filteredOptions.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => handleSelect(option.value)}
                    className={cn(
                      "relative flex w-full items-center px-3 py-2",
                      "text-sm rounded-md",
                      "hover:bg-gray-100/80 dark:hover:bg-white/10",
                      "text-gray-900 dark:text-white",
                      "transition-colors duration-200",
                      "focus:outline-none focus:bg-gray-100/80 dark:focus:bg-white/10",
                      value === option.value && "bg-cyan-50/50 dark:bg-cyan-900/20",
                    )}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === option.value ? "opacity-100 text-cyan-600 dark:text-cyan-400" : "opacity-0",
                      )}
                    />
                    <div className="flex-1 text-left">
                      <div className="font-medium">{option.label}</div>
                      {option.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{option.description}</div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  },
);

ComboBox.displayName = "ComboBox";
