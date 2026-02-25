import { TrendingUp } from "lucide-react";
import type { Task } from "@/features/projects/tasks/types";
import type { Sprint } from "../types";

interface SprintVelocityPanelProps {
  sprint: Sprint;
  tasks: Task[];
}

interface DayBar {
  label: string;
  done: number;
  total: number;
}

/**
 * Generates a daily burn-down series for the sprint window.
 * For each calendar day in [start_date, today], counts tasks whose
 * updated_at falls on or before that day and whose status is "done".
 */
function buildDailyBars(sprint: Sprint, tasks: Task[]): DayBar[] {
  const start = sprint.start_date ? new Date(sprint.start_date) : null;
  const end = sprint.end_date ? new Date(sprint.end_date) : null;
  if (!start) return [];

  const today = new Date();
  const windowEnd = end && end < today ? end : today;

  // Clamp to at most 14 days displayed
  const msPerDay = 86_400_000;
  const totalDays = Math.round((windowEnd.getTime() - start.getTime()) / msPerDay) + 1;
  const displayDays = Math.min(totalDays, 14);
  const displayStart = new Date(windowEnd.getTime() - (displayDays - 1) * msPerDay);

  const total = tasks.length;

  const bars: DayBar[] = [];
  for (let i = 0; i < displayDays; i++) {
    const dayMs = displayStart.getTime() + i * msPerDay;
    const dayEnd = dayMs + msPerDay - 1;
    const done = tasks.filter((t) => {
      if (t.status !== "done") return false;
      const updatedMs = new Date(t.updated_at).getTime();
      return updatedMs <= dayEnd;
    }).length;

    const date = new Date(dayMs);
    const label =
      displayDays <= 7
        ? date.toLocaleDateString("en-US", { weekday: "short" })
        : date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });

    bars.push({ label, done, total });
  }
  return bars;
}

/** Inline SVG bar chart — no external chart library required. */
function VelocityChart({ bars }: { bars: DayBar[] }) {
  if (bars.length === 0) {
    return (
      <p className="text-xs text-gray-500 italic text-center py-6">No sprint dates configured — set start/end dates to see burn-down.</p>
    );
  }

  // Denominator for bar height normalization — total task count, minimum 1 to prevent division by zero
  const maxTotal = bars[0]?.total > 0 ? bars[0].total : 1;
  const chartHeight = 80;
  const barWidth = Math.max(8, Math.min(24, Math.floor(280 / bars.length) - 4));
  const gap = Math.max(2, Math.min(6, Math.floor(280 / bars.length) - barWidth));
  const chartWidth = bars.length * (barWidth + gap) - gap;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight + 18}`}
        className="w-full"
        style={{ minWidth: `${Math.max(chartWidth, 200)}px`, maxWidth: "560px" }}
        aria-label="Sprint burn-down chart"
        role="img"
      >
        {/* Gradient definitions — declared first so fill references resolve correctly */}
        <defs>
          <linearGradient id="gradProgress" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(34,211,238)" stopOpacity={0.9} />
            <stop offset="100%" stopColor="rgb(59,130,246)" stopOpacity={0.7} />
          </linearGradient>
          <linearGradient id="gradComplete" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(74,222,128)" stopOpacity={0.9} />
            <stop offset="100%" stopColor="rgb(34,197,94)" stopOpacity={0.7} />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines */}
        {[0, 0.5, 1].map((ratio) => {
          const y = chartHeight - ratio * chartHeight;
          return (
            <line
              key={ratio}
              x1={0}
              y1={y}
              x2={chartWidth}
              y2={y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          );
        })}

        {/* Bars */}
        {bars.map((bar, i) => {
          const x = i * (barWidth + gap);
          const doneRatio = bar.done / maxTotal;
          const barH = Math.max(2, doneRatio * chartHeight);
          const y = chartHeight - barH;
          const isComplete = bar.done === bar.total && bar.total > 0;
          const fill = isComplete
            ? "url(#gradComplete)"
            : bar.done > 0
              ? "url(#gradProgress)"
              : "rgba(255,255,255,0.08)";

          return (
            <g key={i}>
              {/* Background bar (total capacity) */}
              <rect
                x={x}
                y={0}
                width={barWidth}
                height={chartHeight}
                rx={3}
                fill="rgba(255,255,255,0.04)"
              />
              {/* Done bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={3}
                fill={fill}
              />
              {/* Done count label above bar */}
              {bar.done > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={Math.max(0, y - 2)}
                  textAnchor="middle"
                  fontSize={7}
                  fill="rgba(255,255,255,0.55)"
                >
                  {bar.done}
                </text>
              )}
              {/* Day label below */}
              <text
                x={x + barWidth / 2}
                y={chartHeight + 12}
                textAnchor="middle"
                fontSize={7}
                fill="rgba(255,255,255,0.35)"
              >
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Sprint velocity panel showing a daily burn-down bar chart for the
 * selected sprint. Derives done-count per day from task updated_at
 * timestamps — no external chart library required.
 */
export function SprintVelocityPanel({ sprint, tasks }: SprintVelocityPanelProps) {
  const bars = buildDailyBars(sprint, tasks);
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const reviewTasks = tasks.filter((t) => t.status === "review").length;
  const doingTasks = tasks.filter((t) => t.status === "doing").length;
  const todoTasks = tasks.filter((t) => t.status === "todo").length;

  const velocityPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const lastBar = bars[bars.length - 1];
  const todayDone = lastBar?.done ?? doneTasks;

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-5 py-4 space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">Velocity</span>
        </div>
        <span className="text-xs text-gray-500">
          {doneTasks}/{totalTasks} done
        </span>
      </div>

      {/* Stat pills */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: "Done", count: doneTasks, color: "text-green-400 bg-green-500/10 border-green-500/20" },
          { label: "Review", count: reviewTasks, color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
          { label: "Doing", count: doingTasks, color: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
          { label: "Todo", count: todoTasks, color: "text-gray-400 bg-gray-500/10 border-gray-500/20" },
        ].map(({ label, count, color }) => (
          <div
            key={label}
            className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg border ${color}`}
          >
            <span className="text-base font-bold leading-none">{count}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">{label}</span>
          </div>
        ))}
      </div>

      {/* Burn-down chart */}
      {bars.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-600 uppercase tracking-widest">Tasks completed per day</p>
          <VelocityChart bars={bars} />
        </div>
      ) : (
        <p className="text-xs text-gray-500 italic text-center py-2">
          Set sprint start/end dates to enable the burn-down chart.
        </p>
      )}

      {/* Summary footer */}
      <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60 text-[11px]">
        <span className="text-gray-500">
          Cumulative velocity: <span className="text-white font-medium">{velocityPct}%</span>
        </span>
        {sprint.end_date && (
          <span className="text-gray-500">
            Tasks done today: <span className="text-cyan-400 font-medium">{todayDone}</span>
          </span>
        )}
      </div>
    </div>
  );
}
