import { ArrowDownToLine, Check, ExternalLink, FileText, Loader2, Rocket } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../ui/primitives/button";
import { Card } from "../../ui/primitives/card";
import { useDemotePlanToIdea } from "../hooks/usePlanPromoterQueries";
import type { Plan } from "../types";
import { PlanContentModal } from "./PlanContentModal";

interface PlanCardProps {
  plan: Plan;
  onPromote: (plan: Plan) => void;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  ACTIVE: { label: "ACTIVE", className: "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30" },
  COMPLETE: { label: "COMPLETE", className: "bg-gray-500/20 text-gray-400 border border-gray-500/30" },
  DRAFT: { label: "DRAFT", className: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" },
  REVIEW: { label: "REVIEW", className: "bg-orange-500/20 text-orange-400 border border-orange-500/30" },
  RESOLVED: { label: "RESOLVED", className: "bg-gray-500/20 text-gray-400 border border-gray-500/30" },
};

export function PlanCard({ plan, onPromote }: PlanCardProps) {
  const badge = STATUS_BADGE[plan.status] ?? {
    label: plan.status,
    className: "bg-gray-500/20 text-gray-400 border border-gray-500/30",
  };

  const isPromotable = plan.status === "ACTIVE" && !plan.already_promoted;

  const [contentModalOpen, setContentModalOpen] = useState(false);
  const [demoted, setDemoted] = useState(false);
  const { mutate: demote, isPending: isDemoting } = useDemotePlanToIdea();

  function handleDemote() {
    demote(
      { plan_path: plan.path, plan_name: plan.name, notes: plan.notes, section: plan.section },
      { onSuccess: () => setDemoted(true) },
    );
  }

  return (
    <>
      <Card glowColor={isPromotable ? "cyan" : "none"} glowType="outer" glowSize="sm" className="flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">{plan.name}</h3>
          <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${badge.className}`}>
            {badge.label}
          </span>
        </div>

        {/* Path */}
        <p className="text-[11px] text-gray-500 dark:text-zinc-500 font-mono truncate" title={plan.path}>
          {plan.path}
        </p>

        {/* Notes */}
        {plan.notes && <p className="text-xs text-gray-600 dark:text-zinc-400 line-clamp-2">{plan.notes}</p>}

        {/* Primary action */}
        <div className="mt-auto pt-1">
          {plan.already_promoted && plan.project_id ? (
            <Link
              to={`/projects/${plan.project_id}`}
              className="inline-flex items-center gap-1.5 text-xs text-cyan-500 hover:text-cyan-400 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View Project
            </Link>
          ) : isPromotable ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full text-xs border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-400"
              onClick={() => onPromote(plan)}
            >
              <Rocket className="h-3.5 w-3.5 mr-1.5" />
              Promote to Project
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="w-full text-xs opacity-40 cursor-not-allowed" disabled>
              <Rocket className="h-3.5 w-3.5 mr-1.5" />
              {plan.status === "COMPLETE" ? "Already complete" : "Not promotable"}
            </Button>
          )}
        </div>

        {/* Secondary actions */}
        <div className="flex items-center gap-3 border-t border-gray-800/50 pt-2">
          <button
            type="button"
            onClick={() => setContentModalOpen(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-cyan-400 transition-colors"
          >
            <FileText className="h-3 w-3" />
            Open Plan
          </button>
          <span className="text-gray-800">·</span>
          {demoted ? (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check className="h-3 w-3" />
              Sent to Ideas
            </span>
          ) : (
            <button
              type="button"
              onClick={handleDemote}
              disabled={isDemoting}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-400 transition-colors disabled:opacity-50"
            >
              {isDemoting ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDownToLine className="h-3 w-3" />}
              Demote to Idea
            </button>
          )}
        </div>
      </Card>

      <PlanContentModal plan={plan} open={contentModalOpen} onOpenChange={setContentModalOpen} />
    </>
  );
}
