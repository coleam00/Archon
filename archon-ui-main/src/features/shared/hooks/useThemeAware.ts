/**
 * Theme-aware utilities for Radix primitives
 * Works with existing ThemeContext
 */

import { useTheme } from "../../../contexts/ThemeContext";

export function useThemeAware() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  const isLight = theme === "light";

  // Get theme-specific values
  const getThemeValue = <T>(lightValue: T, darkValue: T): T => {
    return isDark ? darkValue : lightValue;
  };

  // Get theme-specific colors for Tron effects
  const glowColors = {
    cyan: isDark
      ? "rgba(34,211,238,0.7)" // Stronger glow in dark
      : "rgba(34,211,238,0.4)", // Softer glow in light
    blue: isDark ? "rgba(59,130,246,0.7)" : "rgba(59,130,246,0.4)",
    purple: isDark ? "rgba(168,85,247,0.7)" : "rgba(168,85,247,0.4)",
  };

  // Get appropriate backdrop blur intensity
  const blurIntensity = isDark ? "backdrop-blur-md" : "backdrop-blur-sm";

  return {
    theme,
    setTheme,
    isDark,
    isLight,
    getThemeValue,
    glowColors,
    blurIntensity,
  };
}

// Theme-aware style presets for consistent look
export const themeStyles = {
  // Card styles that adapt to theme
  card: {
    light: "bg-gradient-to-b from-white/80 to-white/60 border-gray-200",
    dark: "bg-gradient-to-b from-white/10 to-black/30 border-gray-700",
    both: "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border border-gray-200 dark:border-gray-700",
  },

  // Panel styles (dropdowns, modals, etc.)
  panel: {
    light: "bg-gradient-to-b from-white/95 to-white/90 border-gray-200",
    dark: "bg-gradient-to-b from-gray-800/95 to-gray-900/95 border-gray-700",
    both: "bg-gradient-to-b from-white/95 to-white/90 dark:from-gray-800/95 dark:to-gray-900/95 border border-gray-200 dark:border-gray-700",
  },

  // Text colors
  text: {
    primary: "text-gray-900 dark:text-white",
    secondary: "text-gray-600 dark:text-gray-400",
    muted: "text-gray-500 dark:text-gray-500",
  },

  // Glow effects for Tron aesthetic
  glow: {
    cyan: "shadow-[0_0_10px_2px_rgba(34,211,238,0.4)] dark:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]",
    blue: "shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]",
    purple: "shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]",
  },
};
