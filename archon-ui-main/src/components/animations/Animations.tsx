import React from 'react';
/**
 * ArchonLoadingSpinner - A loading animation component with neon trail effects
 *
 * This component displays the Archon logo with animated spinning circles
 * that create a neon trail effect. It's used to indicate loading states
 * throughout the application.
 *
 * @param {Object} props - Component props
 * @param {string} props.size - Size variant ('sm', 'md', 'lg')
 * @param {string} props.logoSrc - Source URL for the logo image
 * @param {string} props.className - Additional CSS classes
 */
export const ArchonLoadingSpinner: React.FC<{
  size?: 'sm' | 'md' | 'lg';
  logoSrc?: string;
  className?: string;
}> = ({
  size = 'md',
  logoSrc = "/logo-neon.png",
  className = ''
}) => {
  // Size mappings for the container and logo
  const sizeMap = {
    sm: {
      container: 'w-8 h-8',
      logo: 'w-5 h-5'
    },
    md: {
      container: 'w-10 h-10',
      logo: 'w-7 h-7'
    },
    lg: {
      container: 'w-14 h-14',
      logo: 'w-9 h-9'
    }
  };
  return <div className={`relative ${sizeMap[size].container} flex items-center justify-center ${className}`}>
      {/* Central logo */}
      <img src={logoSrc} alt="Loading" className={`${sizeMap[size].logo} z-10 relative`} />
      {/* Animated spinning circles with neon trail effects */}
      <div className="absolute inset-0 w-full h-full">
        {/* First circle - cyan with clockwise rotation */}
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-cyan-400 animate-[spin_0.8s_linear_infinite] blur-[0.5px] after:content-[''] after:absolute after:inset-0 after:rounded-full after:border-2 after:border-transparent after:border-t-cyan-400/30 after:blur-[3px] after:scale-110"></div>
        {/* Second circle - fuchsia with counter-clockwise rotation */}
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-r-fuchsia-400 animate-[spin_0.6s_linear_infinite_reverse] blur-[0.5px] after:content-[''] after:absolute after:inset-0 after:rounded-full after:border-2 after:border-transparent after:border-r-fuchsia-400/30 after:blur-[3px] after:scale-110"></div>
      </div>
    </div>;
};
/**
 * NeonGlowEffect - A component that adds a neon glow effect to its children
 *
 * This component creates a container with a neon glow effect in different colors.
 * It's used for highlighting UI elements with a cyberpunk/neon aesthetic.
 *
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.children - Child elements
 * @param {string} props.color - Color variant ('cyan', 'fuchsia', 'blue', 'purple', 'green', 'pink')
 * @param {string} props.intensity - Glow intensity ('low', 'medium', 'high')
 * @param {string} props.className - Additional CSS classes
 */
export const NeonGlowEffect: React.FC<{
  children: React.ReactNode;
  color?: 'cyan' | 'fuchsia' | 'blue' | 'purple' | 'green' | 'pink';
  intensity?: 'low' | 'medium' | 'high';
  className?: string;
}> = ({
  children,
  color = 'blue',
  intensity = 'medium',
  className = ''
}) => {
  // Color mappings for different neon colors
  const colorMap = {
    cyan: 'border-cyan-400 shadow-cyan-400/50 dark:shadow-cyan-400/70',
    fuchsia: 'border-fuchsia-400 shadow-fuchsia-400/50 dark:shadow-fuchsia-400/70',
    blue: 'border-blue-400 shadow-blue-400/50 dark:shadow-blue-400/70',
    purple: 'border-purple-500 shadow-purple-500/50 dark:shadow-purple-500/70',
    green: 'border-emerald-500 shadow-emerald-500/50 dark:shadow-emerald-500/70',
    pink: 'border-pink-500 shadow-pink-500/50 dark:shadow-pink-500/70'
  };
  // Intensity mappings for glow strength
  const intensityMap = {
    low: 'shadow-[0_0_5px_0]',
    medium: 'shadow-[0_0_10px_1px]',
    high: 'shadow-[0_0_15px_2px]'
  };
  return <div className={`relative ${className}`}>
      <div className={`absolute inset-0 rounded-md border ${colorMap[color]} ${intensityMap[intensity]}`}></div>
      <div className="relative z-10">{children}</div>
    </div>;
};
/**
 * EdgeLitEffect - A component that adds an edge-lit glow effect
 *
 * This component creates a thin glowing line at the top of a container,
 * simulating the effect of edge lighting.
 *
 * @param {Object} props - Component props
 * @param {string} props.color - Color variant ('blue', 'purple', 'green', 'pink')
 * @param {string} props.className - Additional CSS classes
 */
export const EdgeLitEffect: React.FC<{
  color?: 'blue' | 'purple' | 'green' | 'pink';
  className?: string;
}> = ({
  color = 'blue',
  className = ''
}) => {
  // Color mappings for different edge-lit colors
  const colorMap = {
    blue: 'bg-blue-500 shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]',
    purple: 'bg-purple-500 shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]',
    green: 'bg-emerald-500 shadow-[0_0_10px_2px_rgba(16,185,129,0.4)] dark:shadow-[0_0_20px_5px_rgba(16,185,129,0.7)]',
    pink: 'bg-pink-500 shadow-[0_0_10px_2px_rgba(236,72,153,0.4)] dark:shadow-[0_0_20px_5px_rgba(236,72,153,0.7)]'
  };
  return <div className={`absolute top-0 left-0 w-full h-[2px] ${colorMap[color]} ${className}`}></div>;
};