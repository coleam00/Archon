import { FileText, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { usePlanContent } from "../hooks/usePlanPromoterQueries";
import type { Plan } from "../types";

interface PlanContentModalProps {
  plan: Plan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PlanContentModal({ plan, open, onOpenChange }: PlanContentModalProps) {
  const { data, isLoading, isError, error } = usePlanContent(open && plan ? plan.path : null);

  if (!plan) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-cyan-400" />
            {plan.name}
          </DialogTitle>
          <p className="text-[11px] font-mono text-gray-500 dark:text-zinc-500 mt-1">{plan.path}</p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 mt-3">
          {isLoading && (
            <div className="flex items-center gap-2 py-8 justify-center text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading plan…</span>
            </div>
          )}

          {isError && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <p className="text-sm text-red-400">Failed to load plan file</p>
              <p className="text-xs text-gray-400 mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
            </div>
          )}

          {data && (
            <div className="prose prose-sm prose-invert max-w-none text-gray-300 [&_h1]:text-gray-100 [&_h2]:text-gray-100 [&_h3]:text-gray-200 [&_code]:text-cyan-300 [&_code]:bg-gray-800/60 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-gray-800/60 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-cyan-400 [&_table]:w-full [&_th]:text-left [&_th]:text-gray-400 [&_th]:border-b [&_th]:border-gray-700 [&_td]:border-b [&_td]:border-gray-800 [&_td]:py-1">
              <ReactMarkdown>{data.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
