import { ArrowRightLeft } from "lucide-react";
import type { Handoff, HandoffStatus } from "../../handoffs/types";

interface HandoffPipelinePanelProps {
  handoffs: Handoff[];
  isLoading: boolean;
}

const COLUMNS: { status: HandoffStatus; label: string; headerClass: string; cardClass: string }[] = [
  {
    status: "pending",
    label: "Pending",
    headerClass: "text-yellow-400",
    cardClass: "border-yellow-500/20 bg-yellow-500/5",
  },
  {
    status: "accepted",
    label: "Accepted",
    headerClass: "text-blue-400",
    cardClass: "border-blue-500/20 bg-blue-500/5",
  },
  {
    status: "completed",
    label: "Completed",
    headerClass: "text-green-400",
    cardClass: "border-green-500/20 bg-green-500/5",
  },
];

function HandoffCard({ handoff, cardClass }: { handoff: Handoff; cardClass: string }) {
  const ago = Date.now() - new Date(handoff.created_at).getTime();
  const minutes = Math.floor(ago / 60000);
  const timeLabel = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${cardClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-medium truncate">
          {handoff.from_agent} → {handoff.to_agent}
        </span>
        <span className="text-gray-500 shrink-0">{timeLabel}</span>
      </div>
      {handoff.notes && <p className="text-gray-400 truncate">{handoff.notes}</p>}
    </div>
  );
}

export function HandoffPipelinePanel({ handoffs, isLoading }: HandoffPipelinePanelProps) {
  const grouped: Record<HandoffStatus, Handoff[]> = {
    pending: [],
    accepted: [],
    completed: [],
    rejected: [],
  };
  for (const h of handoffs) {
    if (h.status in grouped) {
      grouped[h.status].push(h);
    }
  }

  return (
    <div className="bg-gray-900/50 border border-gray-700/50 rounded-xl backdrop-blur-sm p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <ArrowRightLeft className="h-4 w-4 text-cyan-400" />
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Handoff Pipeline</h2>
        {!isLoading && (
          <span className="ml-auto text-xs text-gray-500">
            <span className="text-cyan-400 font-bold">{handoffs.length}</span> total
          </span>
        )}
      </div>

      {isLoading && (
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-gray-800/50 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && (
        <div className="grid grid-cols-3 gap-3 min-h-0 flex-1">
          {COLUMNS.map(({ status, label, headerClass, cardClass }) => {
            const items = grouped[status];
            return (
              <div key={status} className="flex flex-col gap-2">
                <div className={`text-xs font-semibold uppercase tracking-wider ${headerClass}`}>
                  {label}
                  <span className="ml-1 text-gray-500 normal-case font-normal">({items.length})</span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && (
                    <div className="text-xs text-gray-600 italic">empty</div>
                  )}
                  {items.slice(0, 5).map((h) => (
                    <HandoffCard key={h.id} handoff={h} cardClass={cardClass} />
                  ))}
                  {items.length > 5 && (
                    <div className="text-xs text-gray-500 text-center">+{items.length - 5} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
