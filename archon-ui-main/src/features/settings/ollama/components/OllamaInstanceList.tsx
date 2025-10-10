import { Card } from '@/features/ui/primitives/card';
import { Button } from '@/features/ui/primitives/button';
import { HealthIndicator } from './HealthIndicator';
import type { OllamaInstance } from '../types';

interface OllamaInstanceListProps {
  instances: OllamaInstance[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  isLoading?: boolean;
}

export const OllamaInstanceList = ({
  instances,
  selectedId,
  onSelect,
  onAdd,
  isLoading
}: OllamaInstanceListProps) => {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="animate-pulse space-y-2">
          <div className="h-20 bg-gray-700/20 rounded-lg"></div>
          <div className="h-20 bg-gray-700/20 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {instances.map(inst => (
        <Card
          key={inst.id}
          glowColor={inst.id === selectedId ? "purple" : "none"}
          glowType="outer"
          glowSize="sm"
          className={`cursor-pointer transition-all ${
            inst.id === selectedId ? 'border-purple-500/50' : ''
          }`}
          onClick={() => onSelect(inst.id)}
        >
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 dark:text-white truncate">
                {inst.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {inst.baseUrl}
              </p>
            </div>
            <HealthIndicator
              status={inst.isHealthy ? 'healthy' : 'unhealthy'}
            />
          </div>
        </Card>
      ))}
      <Button
        variant="outline"
        onClick={onAdd}
        className="w-full border-dashed"
        size="sm"
      >
        + Add Instance
      </Button>
    </div>
  );
};
