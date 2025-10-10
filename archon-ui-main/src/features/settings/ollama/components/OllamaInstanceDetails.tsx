import { Card } from '@/features/ui/primitives/card';
import { Button } from '@/features/ui/primitives/button';
import { HealthIndicator } from './HealthIndicator';
import type { OllamaInstance } from '../types';

interface OllamaInstanceDetailsProps {
  instance: OllamaInstance;
  onTestConnection: () => void;
  onDelete: () => void;
  isTesting?: boolean;
  isDeleting?: boolean;
}

export const OllamaInstanceDetails = ({
  instance,
  onTestConnection,
  onDelete,
  isTesting = false,
  isDeleting = false
}: OllamaInstanceDetailsProps) => {
  return (
    <div className="space-y-6">
      <Card edgePosition="top" edgeColor="cyan">
        <div className="flex items-center justify-between mb-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-gray-800 dark:text-white">
              {instance.name}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate" title={instance.baseUrl}>
              {instance.baseUrl}
            </p>
          </div>
          <HealthIndicator
            status={isTesting ? 'testing' : (instance.isHealthy ? 'healthy' : 'unhealthy')}
          />
        </div>

        {instance.responseTimeMs !== undefined && (
          <div className="mb-4">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Response time: <span className="font-medium">{instance.responseTimeMs}ms</span>
            </p>
          </div>
        )}

        {instance.modelsAvailable !== undefined && (
          <div className="mb-4">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Models available: <span className="font-medium">{instance.modelsAvailable}</span>
            </p>
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <Button
            variant="outline"
            onClick={onTestConnection}
            disabled={isTesting}
            loading={isTesting}
            size="sm"
          >
            {isTesting ? 'Testing...' : 'Test Connection'}
          </Button>
          <Button
            variant="destructive"
            onClick={onDelete}
            disabled={isDeleting}
            loading={isDeleting}
            size="sm"
          >
            {isDeleting ? 'Deleting...' : 'Delete Instance'}
          </Button>
        </div>
      </Card>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Instance Information</h4>
        <div className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
          <p>Type: <span className="font-medium">{instance.instanceType || 'both'}</span></p>
          <p>Enabled: <span className="font-medium">{instance.isEnabled ? 'Yes' : 'No'}</span></p>
          <p>Primary: <span className="font-medium">{instance.isPrimary ? 'Yes' : 'No'}</span></p>
          {instance.loadBalancingWeight !== undefined && (
            <p>Load Balancing Weight: <span className="font-medium">{instance.loadBalancingWeight}</span></p>
          )}
          {instance.lastHealthCheck && (
            <p>Last Health Check: <span className="font-medium">{new Date(instance.lastHealthCheck).toLocaleString()}</span></p>
          )}
        </div>
      </div>
    </div>
  );
};
