/**
 * Shared style utilities for Radix primitives
 * Tron-inspired glassmorphism design system
 *
 * Theme Support:
 * - All styles use Tailwind's dark: prefix for automatic theme switching
 * - Theme is managed by ThemeContext (light/dark)
 * - For runtime theme values, use useThemeAware hook
 */

// Base glassmorphism classes with Tron aesthetic - TRUE GLASS EFFECT
export const glassmorphism = {
  // Background variations - TRUE TRANSPARENCY for glass effect
  background: {
    subtle: "backdrop-blur-xl bg-white/5 dark:bg-white/10",
    strong: "backdrop-blur-xl bg-white/10 dark:bg-white/20",
    card: "backdrop-blur-xl bg-white/5 dark:bg-white/10",
    // Tron-style colored backgrounds - VERY transparent with strong blur
    cyan: "backdrop-blur-xl bg-cyan-400/5 dark:bg-cyan-400/10",
    blue: "backdrop-blur-xl bg-blue-400/5 dark:bg-blue-400/10",
    purple: "backdrop-blur-xl bg-purple-400/5 dark:bg-purple-400/10",
  },

  // Border styles for glass effect - more prominent for edge definition
  border: {
    default: "border border-white/10 dark:border-white/[0.06]",
    cyan: "border border-cyan-400/50 dark:border-cyan-400/40",
    blue: "border border-blue-400/50 dark:border-blue-400/40",
    purple: "border border-purple-400/50 dark:border-purple-400/40",
    focus: "focus:border-cyan-400 focus:shadow-[0_0_30px_10px_rgba(34,211,238,0.6)]",
    hover: "hover:border-cyan-400/80 hover:shadow-[0_0_25px_5px_rgba(34,211,238,0.5)]",
  },

  // Interactive states
  interactive: {
    base: "transition-all duration-200",
    hover: "hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10",
    active: "active:bg-cyan-500/20 dark:active:bg-cyan-400/20",
    selected:
      "data-[state=checked]:bg-cyan-500/20 dark:data-[state=checked]:bg-cyan-400/20 data-[state=checked]:text-cyan-700 dark:data-[state=checked]:text-cyan-300",
    disabled: "disabled:opacity-50 disabled:cursor-not-allowed",
  },

  // Animation presets
  animation: {
    fadeIn:
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
    slideIn: "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
    slideFromTop: "data-[side=bottom]:slide-in-from-top-2",
    slideFromBottom: "data-[side=top]:slide-in-from-bottom-2",
    slideFromLeft: "data-[side=right]:slide-in-from-left-2",
    slideFromRight: "data-[side=left]:slide-in-from-right-2",
  },

  // Shadow effects with Tron-style neon glow
  shadow: {
    sm: "shadow-sm dark:shadow-md",
    md: "shadow-md dark:shadow-lg",
    lg: "shadow-lg dark:shadow-2xl",
    elevated: "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
    // Strong neon glow effects for true Tron aesthetic
    glow: {
      purple: "shadow-[0_0_30px_10px_rgba(168,85,247,0.5)] dark:shadow-[0_0_40px_15px_rgba(168,85,247,0.7)]",
      blue: "shadow-[0_0_30px_10px_rgba(59,130,246,0.5)] dark:shadow-[0_0_40px_15px_rgba(59,130,246,0.7)]",
      green: "shadow-[0_0_30px_10px_rgba(34,197,94,0.5)] dark:shadow-[0_0_40px_15px_rgba(34,197,94,0.7)]",
      red: "shadow-[0_0_30px_10px_rgba(239,68,68,0.5)] dark:shadow-[0_0_40px_15px_rgba(239,68,68,0.7)]",
      orange: "shadow-[0_0_30px_10px_rgba(251,146,60,0.5)] dark:shadow-[0_0_40px_15px_rgba(251,146,60,0.7)]",
      cyan: "shadow-[0_0_30px_10px_rgba(34,211,238,0.5)] dark:shadow-[0_0_40px_15px_rgba(34,211,238,0.7)]",
      pink: "shadow-[0_0_30px_10px_rgba(236,72,153,0.5)] dark:shadow-[0_0_40px_15px_rgba(236,72,153,0.7)]",
    },
  },

  // Edge glow positions - now part of glassCard for better integration
  edgePositions: {
    none: "",
    top: "before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px]",
    left: "before:content-[''] before:absolute before:top-0 before:left-0 before:bottom-0 before:w-[2px]",
    right: "before:content-[''] before:absolute before:top-0 before:right-0 before:bottom-0 before:w-[2px]",
    bottom: "before:content-[''] before:absolute before:bottom-0 before:left-0 before:right-0 before:h-[2px]",
  },

  // Configurable sizes for cards
  sizes: {
    card: {
      sm: "p-4 max-w-sm",
      md: "p-6 max-w-md",
      lg: "p-8 max-w-lg",
      xl: "p-10 max-w-xl",
    },
  },

  // Priority colors (matching our task system)
  priority: {
    critical: {
      background: "bg-red-100/80 dark:bg-red-500/20",
      text: "text-red-600 dark:text-red-400",
      hover: "hover:bg-red-200 dark:hover:bg-red-500/30",
      glow: "hover:shadow-[0_0_10px_rgba(239,68,68,0.3)]",
    },
    high: {
      background: "bg-orange-100/80 dark:bg-orange-500/20",
      text: "text-orange-600 dark:text-orange-400",
      hover: "hover:bg-orange-200 dark:hover:bg-orange-500/30",
      glow: "hover:shadow-[0_0_10px_rgba(249,115,22,0.3)]",
    },
    medium: {
      background: "bg-blue-100/80 dark:bg-blue-500/20",
      text: "text-blue-600 dark:text-blue-400",
      hover: "hover:bg-blue-200 dark:hover:bg-blue-500/30",
      glow: "hover:shadow-[0_0_10px_rgba(59,130,246,0.3)]",
    },
    low: {
      background: "bg-gray-100/80 dark:bg-gray-500/20",
      text: "text-gray-600 dark:text-gray-400",
      hover: "hover:bg-gray-200 dark:hover:bg-gray-500/30",
      glow: "hover:shadow-[0_0_10px_rgba(107,114,128,0.3)]",
    },
  },
};

// Card-specific glass styles with accent colors
export const glassCard = {
  // Base glass card (true transparency) - NO blur here, controlled separately
  base: "relative rounded-lg overflow-hidden border transition-all duration-300",

  // Blur intensity levels - Visible glass effect
  blur: {
    none: "backdrop-blur-none", // No blur (0px)
    sm: "backdrop-blur-sm", // 4px - Light glass
    md: "backdrop-blur-md", // 12px - Medium glass (visible blur)
    lg: "backdrop-blur-lg", // 16px - Strong glass
    xl: "backdrop-blur-xl", // 24px - Very strong glass
    "2xl": "backdrop-blur-2xl", // 40px - Heavy glass
    "3xl": "backdrop-blur-3xl", // 64px - Maximum glass
  },

  // Glass transparency levels - Theme-aware for better color visibility
  transparency: {
    clear: "bg-white/[0.02] dark:bg-white/[0.01]", // Very transparent - see through
    light: "bg-white/[0.08] dark:bg-white/[0.05]", // Light glass - see through clearly
    medium: "bg-white/[0.15] dark:bg-white/[0.08]", // Medium glass - lighter in dark mode
    frosted: "bg-white/[0.40] dark:bg-black/[0.40]", // Frosted - white in light, black in dark
    solid: "bg-white/[0.90] dark:bg-black/[0.95]", // Solid - opaque
  },

  // Edge color mappings for DataCard (edge-lit cards with colored gradients)
  edgeColors: {
    purple: {
      solid: "bg-purple-500",
      gradient: "from-purple-500/40",
      border: "border-purple-500/30",
      bg: "bg-gradient-to-br from-purple-500/8 to-purple-600/3",
    },
    blue: {
      solid: "bg-blue-500",
      gradient: "from-blue-500/40",
      border: "border-blue-500/30",
      bg: "bg-gradient-to-br from-blue-500/8 to-blue-600/3",
    },
    cyan: {
      solid: "bg-cyan-500",
      gradient: "from-cyan-500/40",
      border: "border-cyan-500/30",
      bg: "bg-gradient-to-br from-cyan-500/8 to-cyan-600/3",
    },
    green: {
      solid: "bg-green-500",
      gradient: "from-green-500/40",
      border: "border-green-500/30",
      bg: "bg-gradient-to-br from-green-500/8 to-green-600/3",
    },
    orange: {
      solid: "bg-orange-500",
      gradient: "from-orange-500/40",
      border: "border-orange-500/30",
      bg: "bg-gradient-to-br from-orange-500/8 to-orange-600/3",
    },
    pink: {
      solid: "bg-pink-500",
      gradient: "from-pink-500/40",
      border: "border-pink-500/30",
      bg: "bg-gradient-to-br from-pink-500/8 to-pink-600/3",
    },
    red: {
      solid: "bg-red-500",
      gradient: "from-red-500/40",
      border: "border-red-500/30",
      bg: "bg-gradient-to-br from-red-500/8 to-red-600/3",
    },
  },

  // Colored glass tints - BRIGHT NEON COLORS with higher opacity
  tints: {
    none: "",
    purple: {
      clear: "bg-purple-500/[0.03] dark:bg-purple-400/[0.04]", // 3-4% - barely visible tint
      light: "bg-purple-500/[0.08] dark:bg-purple-400/[0.10]", // 8-10% - subtle colored glass
      medium: "bg-purple-500/[0.15] dark:bg-purple-400/[0.20]", // 15-20% - standard colored glass
      frosted: "bg-purple-500/[0.25] dark:bg-purple-400/[0.35]", // 25-35% - frosted colored glass
      solid: "bg-purple-500/[0.40] dark:bg-purple-400/[0.60]", // 40-60% - bright neon glow
    },
    blue: {
      clear: "bg-blue-500/[0.03] dark:bg-blue-400/[0.04]",
      light: "bg-blue-500/[0.08] dark:bg-blue-400/[0.10]",
      medium: "bg-blue-500/[0.15] dark:bg-blue-400/[0.20]",
      frosted: "bg-blue-500/[0.25] dark:bg-blue-400/[0.35]",
      solid: "bg-blue-500/[0.40] dark:bg-blue-400/[0.60]",
    },
    cyan: {
      clear: "bg-cyan-500/[0.03] dark:bg-cyan-400/[0.04]",
      light: "bg-cyan-500/[0.08] dark:bg-cyan-400/[0.10]",
      medium: "bg-cyan-500/[0.15] dark:bg-cyan-400/[0.20]",
      frosted: "bg-cyan-500/[0.25] dark:bg-cyan-400/[0.35]",
      solid: "bg-cyan-500/[0.40] dark:bg-cyan-400/[0.60]",
    },
    green: {
      clear: "bg-green-500/[0.03] dark:bg-green-400/[0.04]",
      light: "bg-green-500/[0.08] dark:bg-green-400/[0.10]",
      medium: "bg-green-500/[0.15] dark:bg-green-400/[0.20]",
      frosted: "bg-green-500/[0.25] dark:bg-green-400/[0.35]",
      solid: "bg-green-500/[0.40] dark:bg-green-400/[0.60]",
    },
    orange: {
      clear: "bg-orange-500/[0.03] dark:bg-orange-400/[0.04]",
      light: "bg-orange-500/[0.08] dark:bg-orange-400/[0.10]",
      medium: "bg-orange-500/[0.15] dark:bg-orange-400/[0.20]",
      frosted: "bg-orange-500/[0.25] dark:bg-orange-400/[0.35]",
      solid: "bg-orange-500/[0.40] dark:bg-orange-400/[0.60]",
    },
    pink: {
      clear: "bg-pink-500/[0.03] dark:bg-pink-400/[0.04]",
      light: "bg-pink-500/[0.08] dark:bg-pink-400/[0.10]",
      medium: "bg-pink-500/[0.15] dark:bg-pink-400/[0.20]",
      frosted: "bg-pink-500/[0.25] dark:bg-pink-400/[0.35]",
      solid: "bg-pink-500/[0.40] dark:bg-pink-400/[0.60]",
    },
    red: {
      clear: "bg-red-500/[0.03] dark:bg-red-400/[0.04]",
      light: "bg-red-500/[0.08] dark:bg-red-400/[0.10]",
      medium: "bg-red-500/[0.15] dark:bg-red-400/[0.20]",
      frosted: "bg-red-500/[0.25] dark:bg-red-400/[0.35]",
      solid: "bg-red-500/[0.40] dark:bg-red-400/[0.60]",
    },
  },

  // Neon glow effects - BRIGHTER & MORE INTENSE (default = md size)
  variants: {
    none: {
      border: "border-gray-300/20 dark:border-white/10",
      glow: "",
      hover: "hover:bg-white/[0.04] dark:hover:bg-white/[0.02]",
    },
    purple: {
      border: "border-purple-500/50 dark:border-purple-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(168,85,247,0.4)] dark:shadow-[0_0_60px_25px_rgba(168,85,247,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(168,85,247,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(168,85,247,0.8)]",
    },
    blue: {
      border: "border-blue-500/50 dark:border-blue-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(59,130,246,0.4)] dark:shadow-[0_0_60px_25px_rgba(59,130,246,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(59,130,246,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(59,130,246,0.8)]",
    },
    green: {
      border: "border-green-500/50 dark:border-green-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(34,197,94,0.4)] dark:shadow-[0_0_60px_25px_rgba(34,197,94,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(34,197,94,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(34,197,94,0.8)]",
    },
    cyan: {
      border: "border-cyan-500/50 dark:border-cyan-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(34,211,238,0.4)] dark:shadow-[0_0_60px_25px_rgba(34,211,238,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(34,211,238,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(34,211,238,0.8)]",
    },
    orange: {
      border: "border-orange-500/50 dark:border-orange-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(251,146,60,0.4)] dark:shadow-[0_0_60px_25px_rgba(251,146,60,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(251,146,60,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(251,146,60,0.8)]",
    },
    pink: {
      border: "border-pink-500/50 dark:border-pink-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(236,72,153,0.4)] dark:shadow-[0_0_60px_25px_rgba(236,72,153,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(236,72,153,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(236,72,153,0.8)]",
    },
    red: {
      border: "border-red-500/50 dark:border-red-400/40",
      glow: "shadow-[0_0_40px_15px_rgba(239,68,68,0.4)] dark:shadow-[0_0_60px_25px_rgba(239,68,68,0.7)]",
      hover: "hover:shadow-[0_0_50px_20px_rgba(239,68,68,0.5)] dark:hover:shadow-[0_0_80px_30px_rgba(239,68,68,0.8)]",
    },
  },

  // Outer glow size variants (static classes for each color)
  outerGlowSizes: {
    cyan: {
      sm: "shadow-[0_0_20px_rgba(34,211,238,0.3)]",
      md: "shadow-[0_0_40px_rgba(34,211,238,0.4)]",
      lg: "shadow-[0_0_70px_rgba(34,211,238,0.5)]",
      xl: "shadow-[0_0_100px_rgba(34,211,238,0.6)]",
    },
    purple: {
      sm: "shadow-[0_0_20px_rgba(168,85,247,0.3)]",
      md: "shadow-[0_0_40px_rgba(168,85,247,0.4)]",
      lg: "shadow-[0_0_70px_rgba(168,85,247,0.5)]",
      xl: "shadow-[0_0_100px_rgba(168,85,247,0.6)]",
    },
    blue: {
      sm: "shadow-[0_0_20px_rgba(59,130,246,0.3)]",
      md: "shadow-[0_0_40px_rgba(59,130,246,0.4)]",
      lg: "shadow-[0_0_70px_rgba(59,130,246,0.5)]",
      xl: "shadow-[0_0_100px_rgba(59,130,246,0.6)]",
    },
    pink: {
      sm: "shadow-[0_0_20px_rgba(236,72,153,0.3)]",
      md: "shadow-[0_0_40px_rgba(236,72,153,0.4)]",
      lg: "shadow-[0_0_70px_rgba(236,72,153,0.5)]",
      xl: "shadow-[0_0_100px_rgba(236,72,153,0.6)]",
    },
    green: {
      sm: "shadow-[0_0_20px_rgba(34,197,94,0.3)]",
      md: "shadow-[0_0_40px_rgba(34,197,94,0.4)]",
      lg: "shadow-[0_0_70px_rgba(34,197,94,0.5)]",
      xl: "shadow-[0_0_100px_rgba(34,197,94,0.6)]",
    },
    orange: {
      sm: "shadow-[0_0_20px_rgba(251,146,60,0.3)]",
      md: "shadow-[0_0_40px_rgba(251,146,60,0.4)]",
      lg: "shadow-[0_0_70px_rgba(251,146,60,0.5)]",
      xl: "shadow-[0_0_100px_rgba(251,146,60,0.6)]",
    },
    red: {
      sm: "shadow-[0_0_20px_rgba(239,68,68,0.3)]",
      md: "shadow-[0_0_40px_rgba(239,68,68,0.4)]",
      lg: "shadow-[0_0_70px_rgba(239,68,68,0.5)]",
      xl: "shadow-[0_0_100px_rgba(239,68,68,0.6)]",
    },
  },

  // Inner glow variants (static classes for each color) - WIDER range than outer
  innerGlowSizes: {
    cyan: {
      sm: "shadow-[inset_0_0_15px_rgba(34,211,238,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(34,211,238,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(34,211,238,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(34,211,238,0.5)]",
    },
    purple: {
      sm: "shadow-[inset_0_0_15px_rgba(168,85,247,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(168,85,247,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(168,85,247,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(168,85,247,0.5)]",
    },
    blue: {
      sm: "shadow-[inset_0_0_15px_rgba(59,130,246,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(59,130,246,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(59,130,246,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(59,130,246,0.5)]",
    },
    pink: {
      sm: "shadow-[inset_0_0_15px_rgba(236,72,153,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(236,72,153,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(236,72,153,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(236,72,153,0.5)]",
    },
    green: {
      sm: "shadow-[inset_0_0_15px_rgba(34,197,94,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(34,197,94,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(34,197,94,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(34,197,94,0.5)]",
    },
    orange: {
      sm: "shadow-[inset_0_0_15px_rgba(251,146,60,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(251,146,60,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(251,146,60,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(251,146,60,0.5)]",
    },
    red: {
      sm: "shadow-[inset_0_0_15px_rgba(239,68,68,0.2)]",
      md: "shadow-[inset_0_0_40px_rgba(239,68,68,0.3)]",
      lg: "shadow-[inset_0_0_80px_rgba(239,68,68,0.4)]",
      xl: "shadow-[inset_0_0_120px_rgba(239,68,68,0.5)]",
    },
  },

  // Hover glow variants - size-matched (brighter, same size)
  outerGlowHover: {
    cyan: {
      sm: "hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(34,211,238,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(34,211,238,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(34,211,238,0.8)]",
    },
    purple: {
      sm: "hover:shadow-[0_0_20px_rgba(168,85,247,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(168,85,247,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(168,85,247,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(168,85,247,0.8)]",
    },
    blue: {
      sm: "hover:shadow-[0_0_20px_rgba(59,130,246,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(59,130,246,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(59,130,246,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(59,130,246,0.8)]",
    },
    pink: {
      sm: "hover:shadow-[0_0_20px_rgba(236,72,153,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(236,72,153,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(236,72,153,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(236,72,153,0.8)]",
    },
    green: {
      sm: "hover:shadow-[0_0_20px_rgba(34,197,94,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(34,197,94,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(34,197,94,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(34,197,94,0.8)]",
    },
    orange: {
      sm: "hover:shadow-[0_0_20px_rgba(251,146,60,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(251,146,60,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(251,146,60,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(251,146,60,0.8)]",
    },
    red: {
      sm: "hover:shadow-[0_0_20px_rgba(239,68,68,0.5)]",
      md: "hover:shadow-[0_0_40px_rgba(239,68,68,0.6)]",
      lg: "hover:shadow-[0_0_70px_rgba(239,68,68,0.7)]",
      xl: "hover:shadow-[0_0_100px_rgba(239,68,68,0.8)]",
    },
  },

  innerGlowHover: {
    cyan: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(34,211,238,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(34,211,238,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(34,211,238,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(34,211,238,0.7)]",
    },
    purple: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(168,85,247,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(168,85,247,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(168,85,247,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(168,85,247,0.7)]",
    },
    blue: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(59,130,246,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(59,130,246,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(59,130,246,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(59,130,246,0.7)]",
    },
    pink: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(236,72,153,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(236,72,153,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(236,72,153,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(236,72,153,0.7)]",
    },
    green: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(34,197,94,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(34,197,94,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(34,197,94,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(34,197,94,0.7)]",
    },
    orange: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(251,146,60,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(251,146,60,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(251,146,60,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(251,146,60,0.7)]",
    },
    red: {
      sm: "hover:shadow-[inset_0_0_15px_rgba(239,68,68,0.4)]",
      md: "hover:shadow-[inset_0_0_40px_rgba(239,68,68,0.5)]",
      lg: "hover:shadow-[inset_0_0_80px_rgba(239,68,68,0.6)]",
      xl: "hover:shadow-[inset_0_0_120px_rgba(239,68,68,0.7)]",
    },
  },

  // Size variants
  sizes: {
    none: "p-0",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
    xl: "p-10",
  },

  // Edge-lit effects for cards (top, left, right, bottom edges)
  edgeLit: {
    position: {
      none: "",
      top: "before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] before:rounded-t-lg",
      left: "before:content-[''] before:absolute before:top-0 before:left-0 before:bottom-0 before:w-[2px] before:rounded-l-lg",
      right:
        "before:content-[''] before:absolute before:top-0 before:right-0 before:bottom-0 before:w-[2px] before:rounded-r-lg",
      bottom:
        "before:content-[''] before:absolute before:bottom-0 before:left-0 before:right-0 before:h-[2px] before:rounded-b-lg",
    },
    color: {
      purple: {
        line: "before:bg-purple-500 dark:before:bg-purple-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(168,85,247,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-purple-500 dark:before:via-purple-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-purple-500 dark:before:via-purple-400 before:to-transparent",
        },
      },
      blue: {
        line: "before:bg-blue-500 dark:before:bg-blue-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(59,130,246,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-blue-500 dark:before:via-blue-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-blue-500 dark:before:via-blue-400 before:to-transparent",
        },
      },
      cyan: {
        line: "before:bg-cyan-500 dark:before:bg-cyan-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(34,211,238,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-cyan-500 dark:before:via-cyan-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-cyan-500 dark:before:via-cyan-400 before:to-transparent",
        },
      },
      green: {
        line: "before:bg-green-500 dark:before:bg-green-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(34,197,94,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-green-500 dark:before:via-green-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-green-500 dark:before:via-green-400 before:to-transparent",
        },
      },
      orange: {
        line: "before:bg-orange-500 dark:before:bg-orange-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(251,146,60,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-orange-500 dark:before:via-orange-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-orange-500 dark:before:via-orange-400 before:to-transparent",
        },
      },
      pink: {
        line: "before:bg-pink-500 dark:before:bg-pink-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(236,72,153,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-pink-500 dark:before:via-pink-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-pink-500 dark:before:via-pink-400 before:to-transparent",
        },
      },
      red: {
        line: "before:bg-red-500 dark:before:bg-red-400",
        glow: "before:shadow-[0_0_15px_4px_rgba(239,68,68,0.8)]",
        gradient: {
          horizontal:
            "before:bg-gradient-to-r before:from-transparent before:via-red-500 dark:before:via-red-400 before:to-transparent",
          vertical:
            "before:bg-gradient-to-b before:from-transparent before:via-red-500 dark:before:via-red-400 before:to-transparent",
        },
      },
    },
  },
};

// Compound styles for common patterns
export const compoundStyles = {
  // Standard interactive element (buttons, menu items, etc.)
  interactiveElement: `
    ${glassmorphism.interactive.base}
    ${glassmorphism.interactive.hover}
    ${glassmorphism.interactive.disabled}
  `,

  // Floating panels (dropdowns, popovers, tooltips)
  floatingPanel: `
    ${glassmorphism.background.strong}
    ${glassmorphism.border.default}
    ${glassmorphism.shadow.lg}
    ${glassmorphism.animation.fadeIn}
    ${glassmorphism.animation.slideIn}
  `,

  // Form controls (inputs, selects, etc.)
  formControl: `
    ${glassmorphism.background.subtle}
    ${glassmorphism.border.default}
    ${glassmorphism.border.hover}
    ${glassmorphism.border.focus}
    ${glassmorphism.interactive.base}
    ${glassmorphism.interactive.disabled}
  `,

  // Cards - use glassCard instead
  card: `
    ${glassmorphism.background.card}
    ${glassmorphism.border.default}
    ${glassmorphism.shadow.md}
  `,
};

// Utility function to combine classes
export function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
