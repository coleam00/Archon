import React, { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../../lib/utils';
import { useToast } from '../../contexts/ToastContext';
import { ollamaService } from '../../services/ollamaService';
import type { HealthIndicatorProps } from './types/OllamaTypes';

/**
 * Health indicator component for individual Ollama instances
 * 
 * Displays real-time health status with refresh capabilities
 * and detailed error information when instances are unhealthy.
 */
export const OllamaInstanceHealthIndicator: React.FC<HealthIndicatorProps> = ({
  instance,
  onRefresh,
  showDetails = true
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { showToast } = useToast();

  const handleRefresh = async () => {
    if (isRefreshing) return;
    
    setIsRefreshing(true);
    try {
      // Use the ollamaService to test the connection
      const healthResult = await ollamaService.testConnection(instance.baseUrl);
      
      // Notify parent component of the refresh result
      onRefresh(instance.id);
      
      if (healthResult.isHealthy) {
        showToast(
          `Health check successful for ${instance.name} (${healthResult.responseTime?.toFixed(0)}ms)`,
          'success'
        );
      } else {
        showToast(
          `Health check failed for ${instance.name}: ${healthResult.error}`,
          'error'
        );
      }
    } catch (error) {
      console.error('Health check failed:', error);
      showToast(
        `Failed to check health for ${instance.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  const getHealthStatusBadge = () => {
    if (isRefreshing) {
      return (
        <Badge variant="outline" className="animate-pulse">
          <div className="w-2 h-2 rounded-full bg-gray-500 animate-ping mr-1" />
          Checking...
        </Badge>
      );
    }
    
    if (instance.healthStatus.isHealthy) {
      return (
        <Badge 
          variant="solid" 
          className="flex items-center gap-1 bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-700"
        >
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Online
        </Badge>
      );
    }
    
    return (
      <Badge 
        variant="solid" 
        className="flex items-center gap-1 bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100 dark:border-red-700"
      >
        <div className="w-2 h-2 rounded-full bg-red-500" />
        Offline
      </Badge>
    );
  };

  const getInstanceTypeIcon = () => {
    switch (instance.instanceType) {
      case 'chat':
        return '💬';
      case 'embedding':
        return '🔢';
      case 'both':
        return '🔄';
      default:
        return '🤖';
    }
  };

  const formatLastChecked = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  if (!showDetails) {
    // Compact mode - just the status badge and refresh button
    return (
      <div className="flex items-center gap-2">
        {getHealthStatusBadge()}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="p-1 h-6 w-6"
          title={`Refresh health status for ${instance.name}`}
        >
          <svg
            className={cn("w-3 h-3", isRefreshing && "animate-spin")}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </Button>
      </div>
    );
  }

  // Full detailed mode
  return (
    <Card className="p-3 bg-gray-50 dark:bg-gray-800/50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg" title={`Instance type: ${instance.instanceType}`}>
            {getInstanceTypeIcon()}
          </span>
          <div>
            <div className="font-medium text-gray-900 dark:text-white text-sm">
              {instance.name}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {new URL(instance.baseUrl).host}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {getHealthStatusBadge()}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1"
            title={`Refresh health status for ${instance.name}`}
          >
            <svg
              className={cn("w-4 h-4", isRefreshing && "animate-spin")}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </Button>
        </div>
      </div>

      {/* Health Details */}
      <div className="space-y-2">
        {instance.healthStatus.isHealthy && (
          <div className="grid grid-cols-2 gap-4 text-xs">
            {instance.healthStatus.responseTimeMs && (
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Response Time:</span>
                <span className={cn(
                  "font-mono",
                  instance.healthStatus.responseTimeMs < 100 
                    ? "text-green-600 dark:text-green-400"
                    : instance.healthStatus.responseTimeMs < 500
                    ? "text-yellow-600 dark:text-yellow-400"
                    : "text-red-600 dark:text-red-400"
                )}>
                  {instance.healthStatus.responseTimeMs.toFixed(0)}ms
                </span>
              </div>
            )}
            
            {instance.modelsAvailable !== undefined && (
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Models:</span>
                <span className="font-mono text-blue-600 dark:text-blue-400">
                  {instance.modelsAvailable}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Error Details */}
        {!instance.healthStatus.isHealthy && instance.healthStatus.error && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs">
            <div className="font-medium text-red-800 dark:text-red-200 mb-1">
              Connection Error:
            </div>
            <div className="text-red-600 dark:text-red-300 font-mono">
              {instance.healthStatus.error}
            </div>
          </div>
        )}

        {/* Instance Configuration */}
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            {instance.isPrimary && (
              <Badge variant="outline" className="text-xs">
                Primary
              </Badge>
            )}
            
            {instance.instanceType !== 'both' && (
              <Badge 
                variant="solid" 
                className={cn(
                  "text-xs",
                  instance.instanceType === 'chat'
                    ? "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-100"
                    : "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-100"
                )}
              >
                {instance.instanceType}
              </Badge>
            )}
          </div>
          
          <div className="text-gray-500 dark:text-gray-400">
            Last checked: {formatLastChecked(instance.healthStatus.lastChecked)}
          </div>
        </div>

        {/* Load Balancing Weight */}
        {instance.loadBalancingWeight !== undefined && instance.loadBalancingWeight !== 100 && (
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Load balancing weight: {instance.loadBalancingWeight}%
          </div>
        )}
      </div>
    </Card>
  );
};

export default OllamaInstanceHealthIndicator;