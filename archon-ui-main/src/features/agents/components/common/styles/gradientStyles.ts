/**
 * Gradient Styles System
 *
 * Centralized gradient definitions for consistent Tron-inspired theming
 * across agent components
 */

export interface GradientTheme {
  background: string;
  border: string;
  backdropFilter: string;
}

export interface CardGradients {
  inactive: GradientTheme;
  active: GradientTheme;
  warning: GradientTheme;
  success: GradientTheme;
  error: GradientTheme;
}

/**
 * Standard card gradients used across the application
 */
export const cardGradients: CardGradients = {
  inactive: {
    background:
      "linear-gradient(135deg, rgba(20, 20, 30, 0.8) 0%, rgba(15, 15, 25, 0.9) 100%)",
    border:
      "linear-gradient(180deg, rgba(100, 100, 120, 0.2) 0%, rgba(80, 80, 100, 0.1) 100%)",
    backdropFilter: "blur(10px)",
  },
  active: {
    background:
      "linear-gradient(135deg, rgba(30, 25, 40, 0.9) 0%, rgba(20, 20, 30, 0.95) 100%)",
    border:
      "linear-gradient(180deg, rgba(168, 85, 247, 0.6) 0%, rgba(7, 180, 130, 0.4) 100%)",
    backdropFilter: "blur(10px)",
  },
  warning: {
    background:
      "linear-gradient(135deg, rgba(30, 25, 20, 0.9) 0%, rgba(25, 20, 15, 0.95) 100%)",
    border:
      "linear-gradient(180deg, rgba(251, 191, 36, 0.3) 0%, rgba(251, 191, 36, 0.1) 100%)",
    backdropFilter: "blur(10px)",
  },
  success: {
    background:
      "linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)",
    border:
      "linear-gradient(180deg, rgba(168, 85, 247, 0.3) 0%, rgba(59, 130, 246, 0.2) 100%)",
    backdropFilter: "blur(10px)",
  },
  error: {
    background:
      "linear-gradient(135deg, rgba(25, 15, 20, 0.9) 0%, rgba(20, 10, 15, 0.95) 100%)",
    border:
      "linear-gradient(180deg, rgba(239, 68, 68, 0.3) 0%, rgba(239, 68, 68, 0.1) 100%)",
    backdropFilter: "blur(10px)",
  },
};

/**
 * Generate style object for gradient cards
 */
export const getCardStyle = (
  theme: keyof CardGradients
): React.CSSProperties => {
  const gradient = cardGradients[theme];
  return {
    background: gradient.background,
    backdropFilter: gradient.backdropFilter,
  };
};

/**
 * Generate style object for gradient borders
 */
export const getBorderStyle = (
  theme: keyof CardGradients
): React.CSSProperties => {
  const gradient = cardGradients[theme];
  return {
    background: gradient.border,
  };
};

/**
 * Utility for conditional gradient themes
 */
export const getThemeForState = (
  isActive?: boolean,
  hasError?: boolean,
  hasWarning?: boolean
): keyof CardGradients => {
  if (hasError) return "error";
  if (hasWarning) return "warning";
  if (isActive) return "active";
  return "inactive";
};

/**
 * Range slider gradient styles
 */
export const getRangeSliderStyle = (
  value: number,
  max: number,
  color = "#7c3aed"
): React.CSSProperties => {
  const percentage = (value / max) * 100;
  return {
    background: `linear-gradient(to right, ${color} 0%, ${color} ${percentage}%, #27272a ${percentage}%, #27272a 100%)`,
  };
};
