import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const statusVariants = {
  healthy: {
    container: "bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400",
    icon: CheckCircle,
  },
  unhealthy: {
    container: "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400",
    icon: XCircle,
  },
  testing: {
    container: "bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400",
    icon: Loader2,
  },
} satisfies Record<string, {container: string; icon: LucideIcon}>;

interface HealthIndicatorProps {
  status: 'healthy' | 'unhealthy' | 'testing';
  label?: string;
}

export const HealthIndicator = ({ status, label }: HealthIndicatorProps) => {
  const variant = statusVariants[status];
  const Icon = variant.icon;
  const displayLabel = label || status;

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded-md border ${variant.container}`}>
      <Icon className={`w-4 h-4 ${status === 'testing' ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="text-xs font-medium capitalize">{displayLabel}</span>
    </div>
  );
};
