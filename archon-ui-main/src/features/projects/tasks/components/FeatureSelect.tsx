/**
 * FeatureSelect Component
 *
 * Radix-based feature selection with autocomplete
 * Replaces the legacy FeatureInput component
 */

import React, { memo } from "react";
import { ComboBox, type ComboBoxOption } from "../../../ui/primitives";

interface FeatureSelectProps {
  value: string;
  onChange: (value: string) => void;
  projectFeatures: Array<{
    id: string;
    label: string;
    type?: string;
    color?: string;
  }>;
  isLoadingFeatures?: boolean;
  placeholder?: string;
  className?: string;
}

export const FeatureSelect = memo(
  ({
    value,
    onChange,
    projectFeatures,
    isLoadingFeatures = false,
    placeholder = "Select or create feature...",
    className,
  }: FeatureSelectProps) => {
    // Transform features to ComboBox options
    const options: ComboBoxOption[] = React.useMemo(
      () =>
        projectFeatures.map((feature) => ({
          value: feature.label,
          label: feature.label,
          description: feature.type ? `Type: ${feature.type}` : undefined,
        })),
      [projectFeatures],
    );

    return (
      <ComboBox
        options={options}
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        searchPlaceholder="Search features..."
        emptyMessage="No features found."
        className={className}
        isLoading={isLoadingFeatures}
        allowCustomValue={true}
      />
    );
  },
);

FeatureSelect.displayName = "FeatureSelect";
