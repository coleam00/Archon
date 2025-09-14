import React from 'react';
interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  color?: 'purple' | 'green' | 'pink' | 'blue' | 'gray' | 'orange';
  variant?: 'solid' | 'outline';
}
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({
  children,
  color = 'gray',
  variant = 'outline',
  className = '',
  ...props
}, ref) => {
  const colorMap = {
    solid: {
      purple: 'bg-purple-500/10 text-purple-500 dark:bg-purple-500/10 dark:text-purple-500',
      green: 'bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/10 dark:text-emerald-500',
      pink: 'bg-pink-500/10 text-pink-500 dark:bg-pink-500/10 dark:text-pink-500',
      blue: 'bg-blue-500/10 text-blue-500 dark:bg-blue-500/10 dark:text-blue-500',
      gray: 'bg-gray-200 text-gray-700 dark:bg-zinc-500/10 dark:text-zinc-400',
      orange: 'bg-orange-500/10 text-orange-500 dark:bg-orange-500/10 dark:text-orange-500'
    },
    outline: {
      purple: 'border border-purple-300 text-purple-600 dark:border-purple-500/30 dark:text-purple-500',
      green: 'border border-emerald-300 text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-500',
      pink: 'border border-pink-300 text-pink-600 dark:border-pink-500/30 dark:text-pink-500',
      blue: 'border border-blue-300 text-blue-600 dark:border-blue-500/30 dark:text-blue-500',
      gray: 'border border-gray-300 text-gray-700 dark:border-zinc-700 dark:text-zinc-400',
      orange: 'border border-orange-500 text-orange-500 dark:border-orange-500 dark:text-orange-500 shadow-[0_0_10px_rgba(251,146,60,0.3)]'
    }
  };
  return <span
    ref={ref}
    className={`
        inline-flex items-center text-xs px-2 py-1 rounded
        ${colorMap[variant][color]}
        ${className}
      `}
    {...props}
  >
    {children}
  </span>;
});

Badge.displayName = 'Badge';