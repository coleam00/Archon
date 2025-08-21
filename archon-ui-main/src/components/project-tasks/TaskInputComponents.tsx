import React, { memo, useState, useEffect, useCallback, useRef } from 'react';

interface DebouncedInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  type?: 'text' | 'textarea';
  rows?: number;
}

// Memoized input component that manages its own state
export const DebouncedInput = memo(({
  value,
  onChange,
  placeholder,
  className,
  type = 'text',
  rows = 5
}: DebouncedInputProps) => {
  const [localValue, setLocalValue] = useState(value);
  const timeoutRef = useRef<NodeJS.Timeout>();
  const isFirstRender = useRef(true);
  
  // Sync with external value only on mount or when externally changed
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // Only update if the external value is different from local
    if (value !== localValue) {
      setLocalValue(value);
    }
  }, [value]);
  
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    
    // Set new timeout for debounced update
    timeoutRef.current = setTimeout(() => {
      onChange(newValue);
    }, 300);
  }, [onChange]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  
  if (type === 'textarea') {
    return (
      <textarea
        value={localValue}
        onChange={handleChange}
        placeholder={placeholder}
        className={className}
        rows={rows}
      />
    );
  }
  
  return (
    <input
      type="text"
      value={localValue}
      onChange={handleChange}
      placeholder={placeholder}
      className={className}
    />
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if external value or onChange changes
  return prevProps.value === nextProps.value && 
         prevProps.onChange === nextProps.onChange &&
         prevProps.placeholder === nextProps.placeholder &&
         prevProps.className === nextProps.className;
});

DebouncedInput.displayName = 'DebouncedInput';

interface FeatureInputProps {
  value: string;
  onChange: (value: string) => void;
  projectFeatures: import('../types/jsonb').ProjectFeature[];
  isLoadingFeatures: boolean;
  placeholder?: string;
  className?: string;
}

// Memoized feature input with datalist
export const FeatureInput = memo(({
  value,
  onChange,
  projectFeatures,
  isLoadingFeatures,
  placeholder,
  className
}: FeatureInputProps) => {
  const [localValue, setLocalValue] = useState(value);
  const timeoutRef = useRef<NodeJS.Timeout>();
  
  // Sync with external value
  useEffect(() => {
    if (value !== localValue) {
      setLocalValue(value);
    }
  }, [value]);
  
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    
    timeoutRef.current = setTimeout(() => {
      onChange(newValue);
    }, 300);
  }, [onChange]);
  
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  
  return (
    <div className="relative">
      <input
        type="text"
        value={localValue}
        onChange={handleChange}
        placeholder={placeholder}
        className={className}
        list="features-list"
      />
      <datalist id="features-list">
        {projectFeatures.map((feature) => (
          <option key={feature.id} value={feature.label}>
            {feature.label} ({feature.type})
          </option>
        ))}
      </datalist>
      {isLoadingFeatures && (
        <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
          <div className="w-4 h-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.value === nextProps.value &&
         prevProps.onChange === nextProps.onChange &&
         prevProps.isLoadingFeatures === nextProps.isLoadingFeatures &&
         prevProps.projectFeatures === nextProps.projectFeatures;
});

FeatureInput.displayName = 'FeatureInput';

// Re-export AssigneeTypeaheadInput for convenience
export { AssigneeTypeaheadInput } from './AssigneeTypeaheadInput';