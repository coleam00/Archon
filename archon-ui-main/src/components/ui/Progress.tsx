import React from 'react';

interface ProgressProps {
  value: number;
  className?: string;
  max?: number;
}

export const Progress: React.FC<ProgressProps> = ({
  value,
  className = '',
  max = 100
}) => {
  const percentage = Math.min(Math.max(value, 0), max);
  
  return (
    <div className={`w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ${className}`}>
      <div 
        className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300 ease-out"
        style={{ 
          width: `${percentage}%`,
          minWidth: percentage > 0 ? '2px' : '0'
        }}
      />
    </div>
  );
};