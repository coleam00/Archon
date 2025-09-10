/**
 * ClassName Helper Utilities
 *
 * Consolidated utilities for building conditional classNames
 */

/**
 * Conditionally join classNames, filtering out falsy values
 */
export const cn = (
  ...classes: (string | undefined | null | false)[]
): string => {
  return classes.filter(Boolean).join(" ");
};

/**
 * Build conditional className based on state
 */
export const conditionalClass = (
  baseClass: string,
  condition: boolean,
  trueClass: string,
  falseClass?: string
): string => {
  return cn(baseClass, condition ? trueClass : falseClass);
};

/**
 * Status-based styling utilities
 */
export const statusStyles = {
  checking: "w-3.5 h-3.5 text-yellow-400 animate-spin",
  healthy: "w-3.5 h-3.5 text-emerald-400",
  unhealthy: "w-3.5 h-3.5 text-red-400",
  unavailable: "w-2 h-2 bg-gray-600 rounded-full",
  available: "w-2 h-2 bg-emerald-400 rounded-full animate-pulse",
} as const;

/**
 * Tab navigation className helper
 */
export const getTabClasses = (isActive: boolean): string => {
  const baseClasses = "pb-3 px-1 border-b-2 transition-colors";
  const activeClasses =
    "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400";
  const inactiveClasses =
    "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white";

  return cn(baseClasses, isActive ? activeClasses : inactiveClasses);
};

/**
 * Button state className helper
 */
export const getButtonClasses = (
  variant: "primary" | "secondary" | "ghost" = "primary",
  isLoading?: boolean,
  isDisabled?: boolean
): string => {
  const baseClasses =
    "px-4 py-2 rounded-lg transition-colors font-medium text-sm";

  const variantClasses = {
    primary: "bg-purple-600 hover:bg-purple-700 text-white",
    secondary: "bg-zinc-700 hover:bg-zinc-600 text-white",
    ghost: "bg-transparent hover:bg-zinc-800 text-gray-300",
  };

  const stateClasses = cn(
    isLoading && "opacity-50 cursor-not-allowed",
    isDisabled && "opacity-50 cursor-not-allowed"
  );

  return cn(baseClasses, variantClasses[variant], stateClasses);
};

/**
 * Input field className helper
 */
export const getInputClasses = (
  hasError?: boolean,
  size: "sm" | "md" = "md"
): string => {
  const baseClasses =
    "bg-zinc-800 text-white rounded-lg focus:outline-none transition-colors";

  const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-3 py-2 text-sm",
  };

  const stateClasses = hasError
    ? "border border-red-500 focus:ring-1 focus:ring-red-500"
    : "border border-zinc-700 focus:ring-1 focus:ring-purple-500";

  return cn(baseClasses, sizeClasses[size], stateClasses);
};

/**
 * Card container className helper
 */
export const getCardClasses = (
  isActive?: boolean,
  isHoverable = true,
  size: "sm" | "md" | "lg" = "md"
): string => {
  const baseClasses =
    "relative rounded-xl overflow-hidden transition-all duration-300";

  const sizeClasses = {
    sm: "p-3",
    md: "p-4",
    lg: "p-6",
  };

  const stateClasses = cn(
    isHoverable && "hover:shadow-2xl hover:shadow-purple-500/20 hover:ring-1 hover:ring-purple-500/30",
    isActive && "ring-1 ring-purple-500/30 shadow-lg shadow-purple-500/10"
  );

  return cn(baseClasses, sizeClasses[size], stateClasses);
};

/**
 * Badge variant className helper
 */
export const getBadgeClasses = (
  variant:
    | "primary"
    | "secondary"
    | "success"
    | "warning"
    | "error" = "primary",
  size: "sm" | "md" = "sm"
): string => {
  const baseClasses = "rounded-full font-medium";

  const sizeClasses = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-3 py-1 text-sm",
  };

  const variantClasses = {
    primary: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
    secondary:
      "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400",
    success: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
    warning: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
    error: "bg-red-500/10 text-red-400 border border-red-500/20",
  };

  return cn(baseClasses, sizeClasses[size], variantClasses[variant]);
};

/**
 * Modal container className helper
 */
export const getModalClasses = (
  size: "sm" | "md" | "lg" | "xl" = "md"
): string => {
  const baseClasses =
    "relative bg-zinc-900 rounded-xl shadow-2xl border border-zinc-800 w-full max-h-[90vh] overflow-hidden transform transition-all animate-fadeInUp";

  const sizeClasses = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  return cn(baseClasses, sizeClasses[size]);
};

/**
 * Form field wrapper className helper
 */
export const getFormFieldClasses = (
  hasError?: boolean,
  isDisabled?: boolean
): string => {
  const baseClasses = "space-y-2";

  const stateClasses = cn(
    hasError && "text-red-400",
    isDisabled && "opacity-50 cursor-not-allowed"
  );

  return cn(baseClasses, stateClasses);
};

/**
 * Icon button className helper
 */
export const getIconButtonClasses = (
  variant: "ghost" | "solid" | "outline" = "ghost",
  size: "sm" | "md" | "lg" = "md"
): string => {
  const baseClasses =
    "inline-flex items-center justify-center rounded-lg transition-colors";

  const sizeClasses = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12",
  };

  const variantClasses = {
    ghost: "text-gray-400 hover:text-white hover:bg-zinc-800",
    solid: "bg-zinc-800 text-white hover:bg-zinc-700",
    outline:
      "border border-zinc-700 text-gray-400 hover:text-white hover:border-zinc-600",
  };

  return cn(baseClasses, sizeClasses[size], variantClasses[variant]);
};

/**
 * Loading spinner className helper
 */
export const getLoadingClasses = (
  size: "sm" | "md" | "lg" = "md",
  color: "white" | "gray" | "purple" = "white"
): string => {
  const baseClasses = "animate-spin rounded-full border-2 border-transparent";

  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-8 h-8",
  };

  const colorClasses = {
    white: "border-t-white",
    gray: "border-t-gray-400",
    purple: "border-t-purple-500",
  };

  return cn(baseClasses, sizeClasses[size], colorClasses[color]);
};

/**
 * Focus ring utility className helper
 */
export const getFocusRingClasses = (
  color: "purple" | "blue" | "green" | "red" = "purple"
): string => {
  const colorClasses = {
    purple: "focus:outline-none focus:ring-1 focus:ring-purple-500",
    blue: "focus:outline-none focus:ring-1 focus:ring-blue-500",
    green: "focus:outline-none focus:ring-1 focus:ring-green-500",
    red: "focus:outline-none focus:ring-1 focus:ring-red-500",
  };

  return colorClasses[color];
};

/**
 * Consolidated utility objects for common patterns
 */
export const spacing = {
  xs: "space-y-1",
  sm: "space-y-2",
  md: "space-y-4",
  lg: "space-y-6",
  xl: "space-y-8",
  "xs-h": "space-x-1",
  "sm-h": "space-x-2",
  "md-h": "space-x-4",
  "lg-h": "space-x-6",
  "xl-h": "space-x-8",
} as const;

export const textStyles = {
  heading: "text-lg font-light text-white",
  subheading: "text-sm font-medium text-gray-300",
  body: "text-sm text-gray-400",
  caption: "text-xs text-gray-500",
  error: "text-sm text-red-400",
  success: "text-sm text-emerald-400",
  warning: "text-sm text-yellow-400",
} as const;

export const animations = {
  fadeIn: "animate-fadeIn",
  fadeInUp: "animate-fadeInUp",
  shimmer: "animate-shimmer",
  pulse: "animate-pulse",
  spin: "animate-spin",
  bounce: "animate-bounce",
} as const;
