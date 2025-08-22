/**
 * Basic Alert component for error display
 * 
 * Provides consistent styling for alerts throughout the application.
 */

import React from 'react';

interface AlertProps {
  children: React.ReactNode;
  variant?: 'default' | 'destructive';
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({ 
  children, 
  variant = 'default', 
  className = '' 
}) => {
  const baseClasses = 'p-4 border rounded-lg';
  const variantClasses = variant === 'destructive' 
    ? 'border-red-300 bg-red-50 text-red-800'
    : 'border-blue-300 bg-blue-50 text-blue-800';

  return (
    <div className={`${baseClasses} ${variantClasses} ${className}`}>
      {children}
    </div>
  );
};

interface AlertDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export const AlertDescription: React.FC<AlertDescriptionProps> = ({ 
  children, 
  className = '' 
}) => {
  return (
    <div className={className}>
      {children}
    </div>
  );
};