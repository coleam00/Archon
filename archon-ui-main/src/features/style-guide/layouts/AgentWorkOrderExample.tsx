import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, ExternalLink, Plus, User } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";
import { cn } from "@/features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/features/ui/primitives/tooltip";
import { RealTimeStatsExample } from "./components/RealTimeStatsExample";
import { StepHistoryCard } from "./components/StepHistoryCard";
import { WorkflowStepButton } from "./components/WorkflowStepButton";

const MOCK_WORK_ORDER = {
  id: "wo-1",
  title: "Create comprehensive documentation",
  status: "in_progress" as const,
  workflow: {
    currentStep: 2,
    steps: [
      { id: "1", name: "Create Branch", status: "completed", duration: "33s" },
      { id: "2", name: "Planning", status: "in_progress", duration: "2m 11s" },
      { id: "3", name: "Execute", status: "pending", duration: null },
      { id: "4", name: "Commit", status: "pending", duration: null },
      { id: "5", name: "Create PR", status: "pending", duration: null },
    ],
  },
  stepHistory: [
    {
      id: "step-1",
      stepName: "Create Branch",
      timestamp: "7 minutes ago",
      output: "docs/remove-archon-mentions",
      session: "Session: a342d9ac-56c4-43ae-95b8-9ddf18143961",
      collapsible: true,
    },
    {
      id: "step-2",
      stepName: "Planning",
      timestamp: "5 minutes ago",
      output: `## Report

**Work completed:**

- Conducted comprehensive codebase audit for "archon" and "Archon" mentions
- Verified main README.md is already breach (no archon mentions present)
- Identified 14 subdirectory README files that need verification
- Discovered historical git commits that added "hello from archon" but content has been removed
- Identified 3 remote branches with "archon" in their names (out of scope for this task)
- Created comprehensive PRP plan for documentation cleanup and verification`,
      session: "Session: e3889823-b272-43c0-b11d-7a786d7e3c88",
      collapsible: true,
      isHumanInLoop: true,
    },
  ],
  document: {
    id: "doc-1",
    title: "Planning Document",
    content: {
      markdown: `# Documentation Cleanup Plan

## Overview
This document outlines the plan to remove all "archon" mentions from the codebase.

## Steps
1. Audit all README files
2. Check git history for sensitive content
3. Verify no configuration files reference "archon"
4. Update documentation

## Progress
- [x] Initial audit complete
- [ ] README updates pending
- [ ] Configuration review pending`,
    },
  },
};

export const AgentWorkOrderExample = () => {
  const [hoveredStepIndex, setHoveredStepIndex] = useState<number | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set(["step-2"]));
  const [showDetails, setShowDetails] = useState(false);
  const [humanInLoopCheckpoints, setHumanInLoopCheckpoints] = useState<Set<number>>(new Set());

  const toggleStepExpansion = (stepId: string) => {
    setExpandedSteps((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(stepId)) {
        newSet.delete(stepId);
      } else {
        newSet.add(stepId);
      }
      return newSet;
    });
  };

  const addHumanInLoopCheckpoint = (index: number) => {
    setHumanInLoopCheckpoints((prev) => {
      const newSet = new Set(prev);
      newSet.add(index);
      return newSet;
    });
    setHoveredStepIndex(null);
  };

  const removeHumanInLoopCheckpoint = (index: number) => {
    setHumanInLoopCheckpoints((prev) => {
      const newSet = new Set(prev);
      newSet.delete(index);
      return newSet;
    });
  };

  return (
    <div className="space-y-6">
      {/* Explanation Text */}
      <p className="text-sm text-gray-600 dark:text-gray-400">
        <strong>Use this layout for:</strong> Agent work order workflows with step-by-step progress tracking,
        collapsible history, and integrated document editing for human-in-the-loop approval.
      </p>

      {/* Real-Time Execution Stats */}
      <RealTimeStatsExample status="plan" stepNumber={2} />

      {/* Workflow Progress Bar */}
      <Card blur="md" transparency="light" edgePosition="top" edgeColor="cyan" size="lg" className="overflow-visible">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{MOCK_WORK_ORDER.title}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDetails(!showDetails)}
            className="text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
            aria-label={showDetails ? "Hide details" : "Show details"}
          >
            {showDetails ? (
              <ChevronUp className="w-4 h-4 mr-1" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-4 h-4 mr-1" aria-hidden="true" />
            )}
            Details
          </Button>
        </div>

        <div className="flex items-center justify-center gap-0">
          {MOCK_WORK_ORDER.workflow.steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              {/* Step Button */}
              <WorkflowStepButton
                isCompleted={step.status === "completed"}
                isActive={step.status === "in_progress"}
                stepName={step.name}
                color="cyan"
                size={50}
              />

              {/* Connecting Line - only show between steps */}
              {index < MOCK_WORK_ORDER.workflow.steps.length - 1 && (
                // biome-ignore lint/a11y/noStaticElementInteractions: Visual hover effect container for showing plus button
                <div
                  className="relative flex-shrink-0"
                  style={{ width: "80px", height: "50px" }}
                  onMouseEnter={() => setHoveredStepIndex(index)}
                  onMouseLeave={() => setHoveredStepIndex(null)}
                >
                  {/* Neon line */}
                  <div
                    className={cn(
                      "absolute top-1/2 left-0 right-0 h-[2px] transition-all duration-200",
                      step.status === "completed"
                        ? "border-t-2 border-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
                        : "border-t-2 border-gray-600 dark:border-gray-700",
                      hoveredStepIndex === index &&
                        step.status !== "completed" &&
                        "border-cyan-400/50 shadow-[0_0_6px_rgba(34,211,238,0.3)]",
                    )}
                  />

                  {/* Human-in-Loop Checkpoint Indicator */}
                  {humanInLoopCheckpoints.has(index) && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => removeHumanInLoopCheckpoint(index)}
                            className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-orange-500 hover:bg-orange-600 rounded-full p-1.5 shadow-lg shadow-orange-500/50 border-2 border-orange-400 transition-colors cursor-pointer"
                            aria-label="Remove Human-in-Loop checkpoint"
                          >
                            <User className="w-3.5 h-3.5 text-white" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Click to remove</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}

                  {/* Plus button on hover - only show if no checkpoint exists */}
                  {hoveredStepIndex === index && !humanInLoopCheckpoints.has(index) && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => addHumanInLoopCheckpoint(index)}
                            className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-orange-500 hover:bg-orange-600 transition-colors shadow-lg shadow-orange-500/50 flex items-center justify-center text-white"
                            aria-label="Add Human-in-Loop step"
                          >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Add Human-in-Loop</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Collapsible Details Section */}
        <AnimatePresence>
          {showDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                height: {
                  duration: 0.3,
                  ease: [0.04, 0.62, 0.23, 0.98],
                },
                opacity: {
                  duration: 0.2,
                  ease: "easeInOut",
                },
              }}
              style={{ overflow: "hidden" }}
              className="mt-6"
            >
              <motion.div
                initial={{ y: -20 }}
                animate={{ y: 0 }}
                exit={{ y: -20 }}
                transition={{
                  duration: 0.2,
                  ease: "easeOut",
                }}
                className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-gray-200/50 dark:border-gray-700/30"
              >
                {/* Left Column */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Details
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Status</p>
                        <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mt-0.5">Running</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Sandbox Type</p>
                        <p className="text-sm font-medium text-gray-900 dark:text-white mt-0.5">git_branch</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Repository</p>
                        <a
                          href="https://github.com/Wirasm/dylan"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-cyan-600 dark:text-cyan-400 hover:underline inline-flex items-center gap-1 mt-0.5"
                        >
                          https://github.com/Wirasm/dylan
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Branch</p>
                        <p className="text-sm font-medium font-mono text-gray-900 dark:text-white mt-0.5">
                          docs/remove-archon-mentions
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Work Order ID</p>
                        <p className="text-sm font-medium font-mono text-gray-700 dark:text-gray-300 mt-0.5">
                          wo-7fd39c8d
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Statistics
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Commits</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">0</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Files Changed</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">0</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Steps Completed</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">2 / 2</p>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* Step History Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Step History</h3>
        {MOCK_WORK_ORDER.stepHistory.map((step) => (
          <StepHistoryCard
            key={step.id}
            step={step}
            isExpanded={expandedSteps.has(step.id)}
            onToggle={() => toggleStepExpansion(step.id)}
            document={step.isHumanInLoop ? MOCK_WORK_ORDER.document : undefined}
          />
        ))}
      </div>
    </div>
  );
};
