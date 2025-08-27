import React from 'react';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  color?: 'purple' | 'green' | 'pink' | 'blue' | 'gray' | 'orange' | 'red' | 'yellow';
  variant?: 'solid' | 'outline' | 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  color = 'gray',
  variant = 'outline',
  size = 'md',
  className = '',
  ...props
}) => {
  // Size classes
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-xs px-2 py-1',
    lg: 'text-sm px-3 py-1'
  };

  // Handle semantic variants
  if (variant === 'success' || variant === 'error' || variant === 'warning' || variant === 'info' || variant === 'primary' || variant === 'secondary') {
    const semanticClasses = {
      success: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
      error: 'bg-red-500/10 text-red-600 dark:bg-red-500/10 dark:text-red-400',
      warning: 'bg-yellow-500/10 text-yellow-600 dark:bg-yellow-500/10 dark:text-yellow-400',
      info: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
      primary: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400 border border-blue-500/20',
      secondary: 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/10 dark:text-purple-400 border border-purple-500/20'
    };
    
    return (
      <span 
        className={`
          inline-flex items-center rounded
          ${sizeClasses[size]}
          ${semanticClasses[variant]}
          ${className}
        `} 
        {...props}
      >
        {children}
      </span>
    );
  }

  // Original color-based logic
  const effectiveColor = color || 'gray';
  const colorMap = {
    solid: {
      purple: 'bg-purple-500/10 text-purple-500 dark:bg-purple-500/10 dark:text-purple-500',
      green: 'bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/10 dark:text-emerald-500',
      pink: 'bg-pink-500/10 text-pink-500 dark:bg-pink-500/10 dark:text-pink-500',
      blue: 'bg-blue-500/10 text-blue-500 dark:bg-blue-500/10 dark:text-blue-500',
      gray: 'bg-gray-200 text-gray-700 dark:bg-zinc-500/10 dark:text-zinc-400',
      orange: 'bg-orange-500/10 text-orange-500 dark:bg-orange-500/10 dark:text-orange-500',
      red: 'bg-red-500/10 text-red-500 dark:bg-red-500/10 dark:text-red-500',
      yellow: 'bg-yellow-500/10 text-yellow-500 dark:bg-yellow-500/10 dark:text-yellow-500'
    },
    outline: {
      purple: 'border border-purple-300 text-purple-600 dark:border-purple-500/30 dark:text-purple-500',
      green: 'border border-emerald-300 text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-500',
      pink: 'border border-pink-300 text-pink-600 dark:border-pink-500/30 dark:text-pink-500',
      blue: 'border border-blue-300 text-blue-600 dark:border-blue-500/30 dark:text-blue-500',
      gray: 'border border-gray-300 text-gray-700 dark:border-zinc-700 dark:text-zinc-400',
      orange: 'border border-orange-500 text-orange-500 dark:border-orange-500 dark:text-orange-500 shadow-[0_0_10px_rgba(251,146,60,0.3)]',
      red: 'border border-red-300 text-red-600 dark:border-red-500/30 dark:text-red-500',
      yellow: 'border border-yellow-300 text-yellow-600 dark:border-yellow-500/30 dark:text-yellow-500'
    }
  };

  return (
    <span 
      className={`
        inline-flex items-center rounded
        ${sizeClasses[size]}
        ${colorMap[variant][effectiveColor]}
        ${className}
      `} 
      {...props}
    >
      {children}
    </span>
  );
};