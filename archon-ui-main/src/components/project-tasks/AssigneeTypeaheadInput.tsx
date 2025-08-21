import React, { useState, useRef, useEffect, useCallback } from 'react';
import { User, Bot, Code, Shield, CheckCircle } from 'lucide-react';

interface AssigneeTypeaheadInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  onKeyPress?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

// Default assignee options with icons
const DEFAULT_ASSIGNEES = [
  { value: 'User', icon: User, color: 'text-blue-500' },
  { value: 'Archon', icon: Bot, color: 'text-pink-500' },
  { value: 'AI IDE Agent', icon: Code, color: 'text-emerald-500' },
  { value: 'IDE Agent', icon: Code, color: 'text-emerald-500' },
  { value: 'prp-executor', icon: Shield, color: 'text-purple-500' },
  { value: 'prp-validator', icon: CheckCircle, color: 'text-cyan-500' }
];

export const AssigneeTypeaheadInput: React.FC<AssigneeTypeaheadInputProps> = ({
  value,
  onChange,
  placeholder = 'Type or select assignee...',
  className = '',
  onKeyPress,
  autoFocus = false
}) => {
  const [inputValue, setInputValue] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [filteredOptions, setFilteredOptions] = useState(DEFAULT_ASSIGNEES);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Update input value when prop changes
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Filter options based on input
  useEffect(() => {
    const filtered = inputValue.trim() === ''
      ? DEFAULT_ASSIGNEES
      : DEFAULT_ASSIGNEES.filter(option =>
          option.value.toLowerCase().includes(inputValue.toLowerCase())
        );
    
    // Add current input as an option if it's not in the default list and not empty
    if (inputValue.trim() && !DEFAULT_ASSIGNEES.find(opt => opt.value.toLowerCase() === inputValue.toLowerCase())) {
      filtered.push({
        value: inputValue,
        icon: User,
        color: 'text-gray-500'
      });
    }
    
    setFilteredOptions(filtered);
    setHighlightedIndex(0);
  }, [inputValue]);

  // Handle clicking outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
  };

  const handleInputFocus = () => {
    setIsOpen(true);
  };

  const handleInputBlur = () => {
    // Delay to allow click on dropdown item
    setTimeout(() => {
      // Only trigger onChange if the value actually changed
      if (inputValue !== value) {
        onChange(inputValue);
      }
      setIsOpen(false);
    }, 200);
  };

  const selectOption = useCallback((optionValue: string) => {
    setInputValue(optionValue);
    onChange(optionValue);
    setIsOpen(false);
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setIsOpen(true);
      e.preventDefault();
      return;
    }

    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => 
          prev < filteredOptions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => 
          prev > 0 ? prev - 1 : filteredOptions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredOptions[highlightedIndex]) {
          selectOption(filteredOptions[highlightedIndex].value);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'Tab':
        if (filteredOptions[highlightedIndex]) {
          selectOption(filteredOptions[highlightedIndex].value);
        }
        break;
    }
  };

  const handleKeyPressWrapper = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Don't trigger the parent's Enter handler if dropdown is open
    if (e.key === 'Enter' && isOpen && filteredOptions.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onKeyPress?.(e);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
        onKeyPress={handleKeyPressWrapper}
        placeholder={placeholder}
        className={className}
        autoFocus={autoFocus}
      />
      
      {isOpen && filteredOptions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg max-h-60 overflow-auto"
        >
          {filteredOptions.map((option, index) => {
            const Icon = option.icon;
            const isHighlighted = index === highlightedIndex;
            
            return (
              <div
                key={option.value}
                onClick={() => selectOption(option.value)}
                className={`
                  flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors
                  ${isHighlighted 
                    ? 'bg-cyan-100 dark:bg-cyan-900/30' 
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                  }
                `}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <Icon className={`w-4 h-4 ${option.color}`} />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {option.value}
                </span>
                {option.value === inputValue && (
                  <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                    current
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};