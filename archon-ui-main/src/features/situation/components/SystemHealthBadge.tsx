import type { SystemHealth } from "../types";

const healthConfig: Record<SystemHealth, { label: string; className: string }> = {
  healthy: {
    label: "Healthy",
    className: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  },
  degraded: {
    label: "Degraded",
    className: "bg-red-500/20 text-red-400 border border-red-500/30",
  },
  warning: {
    label: "Warning",
    className: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  },
};

interface SystemHealthBadgeProps {
  health: SystemHealth;
}

export function SystemHealthBadge({ health }: SystemHealthBadgeProps) {
  const config = healthConfig[health] ?? healthConfig.warning;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}
