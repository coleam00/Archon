import { ArrowRight, BookOpen, ChevronDown, ChevronRight, FileCheck, Lightbulb } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Button } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { useUpdateProject } from "../hooks/useProjectQueries";
import type { Project } from "../types";

// Analysis data shape stored in project.data[0]
interface ProductBrief {
  problem?: string;
  target_users?: string;
  key_outcomes?: string;
  success_metrics?: string;
}

interface AnalysisData {
  brainstorm?: string;
  research?: string;
  product_brief?: ProductBrief;
}

function getAnalysisData(project: Project): AnalysisData {
  const raw = project.data?.[0];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as AnalysisData;
  }
  return {};
}

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ title, icon, defaultOpen = true, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-zinc-800/30 transition-colors"
      >
        <span className="text-zinc-400">{icon}</span>
        <span className="flex-1 text-sm font-semibold uppercase tracking-wider text-zinc-300">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

interface MarkdownAreaProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}

function MarkdownArea({ id, value, onChange, placeholder, rows = 8 }: MarkdownAreaProps) {
  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn(
        "w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-4 py-3",
        "text-sm text-zinc-300 placeholder:text-zinc-600",
        "focus:outline-none focus:ring-1 focus:ring-yellow-500/40 focus:border-yellow-500/40",
        "resize-y font-mono leading-relaxed",
      )}
    />
  );
}

interface AnalysisViewProps {
  project: Project;
}

export function AnalysisView({ project }: AnalysisViewProps) {
  const uid = useId();
  const updateProject = useUpdateProject();
  const analysisData = getAnalysisData(project);

  const [brainstorm, setBrainstorm] = useState(analysisData.brainstorm ?? "");
  const [research, setResearch] = useState(analysisData.research ?? "");
  const [brief, setBrief] = useState<ProductBrief>(analysisData.product_brief ?? {});

  const [saving, setSaving] = useState(false);

  const canAdvance = !!brief.problem?.trim() && !!brief.key_outcomes?.trim();

  const saveAnalysis = useCallback(
    async (updates: Partial<AnalysisData>) => {
      setSaving(true);
      const currentData = getAnalysisData(project);
      const merged: AnalysisData = { ...currentData, ...updates };
      await updateProject.mutateAsync({
        projectId: project.id,
        updates: { data: [merged] },
      });
      setSaving(false);
    },
    [project, updateProject],
  );

  const handleAdvance = useCallback(async () => {
    // Save current data then advance phase
    const currentData = getAnalysisData(project);
    const merged: AnalysisData = {
      ...currentData,
      brainstorm,
      research,
      product_brief: brief,
    };
    updateProject.mutate({
      projectId: project.id,
      updates: { data: [merged], phase: "planning" },
    });
  }, [project, updateProject, brainstorm, research, brief]);

  return (
    <div className="space-y-4">
      {/* Brainstorm */}
      <CollapsibleSection title="Brainstorm" icon={<Lightbulb className="w-4 h-4" />} defaultOpen={true}>
        <MarkdownArea
          value={brainstorm}
          onChange={setBrainstorm}
          placeholder="Capture raw ideas, inspiration, context from conversations..."
          rows={10}
        />
        <div className="flex justify-end mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => saveAnalysis({ brainstorm, research, product_brief: brief })}
            disabled={saving}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CollapsibleSection>

      {/* Research Notes */}
      <CollapsibleSection title="Research Notes" icon={<BookOpen className="w-4 h-4" />} defaultOpen={false}>
        <MarkdownArea
          value={research}
          onChange={setResearch}
          placeholder="Market research, competitive analysis, technical findings..."
          rows={10}
        />
        <div className="flex justify-end mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => saveAnalysis({ brainstorm, research, product_brief: brief })}
            disabled={saving}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CollapsibleSection>

      {/* Product Brief */}
      <CollapsibleSection title="Product Brief" icon={<FileCheck className="w-4 h-4" />} defaultOpen={true}>
        <div className="space-y-4">
          <div>
            <label
              htmlFor={`${uid}-problem`}
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Problem Statement <span className="text-yellow-500">*</span>
            </label>
            <MarkdownArea
              id={`${uid}-problem`}
              value={brief.problem ?? ""}
              onChange={(v) => setBrief((b) => ({ ...b, problem: v }))}
              placeholder="What specific problem does this solve? Who experiences it?"
              rows={4}
            />
          </div>

          <div>
            <label
              htmlFor={`${uid}-users`}
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Target Users
            </label>
            <MarkdownArea
              id={`${uid}-users`}
              value={brief.target_users ?? ""}
              onChange={(v) => setBrief((b) => ({ ...b, target_users: v }))}
              placeholder="Who are the primary users? What are their characteristics?"
              rows={3}
            />
          </div>

          <div>
            <label
              htmlFor={`${uid}-outcomes`}
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Key Outcomes <span className="text-yellow-500">*</span>
            </label>
            <MarkdownArea
              id={`${uid}-outcomes`}
              value={brief.key_outcomes ?? ""}
              onChange={(v) => setBrief((b) => ({ ...b, key_outcomes: v }))}
              placeholder="What outcomes must this achieve? What will change for the better?"
              rows={4}
            />
          </div>

          <div>
            <label
              htmlFor={`${uid}-metrics`}
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Success Metrics
            </label>
            <MarkdownArea
              id={`${uid}-metrics`}
              value={brief.success_metrics ?? ""}
              onChange={(v) => setBrief((b) => ({ ...b, success_metrics: v }))}
              placeholder="How will we know this succeeded? Quantitative metrics preferred."
              rows={3}
            />
          </div>

          <div className="flex justify-end mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveAnalysis({ brainstorm, research, product_brief: brief })}
              disabled={saving}
              className="text-xs text-zinc-500 hover:text-zinc-300 mr-3"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Advance button */}
      <div className="flex justify-end pt-2">
        <Button
          onClick={handleAdvance}
          disabled={!canAdvance || updateProject.isPending}
          className={cn(
            "inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg transition-all",
            canAdvance
              ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20"
              : "bg-zinc-800 text-zinc-600 cursor-not-allowed",
          )}
        >
          Advance to Planning
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
      {!canAdvance && (
        <p className="text-right text-xs text-zinc-600">Fill in Problem Statement and Key Outcomes to advance.</p>
      )}
    </div>
  );
}
