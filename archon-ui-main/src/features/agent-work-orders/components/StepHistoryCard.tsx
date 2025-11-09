import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Edit3, Eye } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";
import { cn } from "@/features/ui/primitives/styles";

interface StepHistoryCardProps {
  step: {
    id: string;
    stepName: string;
    timestamp: string;
    output: string;
    session: string;
    collapsible: boolean;
    isHumanInLoop?: boolean;
  };
  isExpanded: boolean;
  onToggle: () => void;
  document?: {
    title: string;
    content: {
      markdown: string;
    };
  };
}

export const StepHistoryCard = ({ step, isExpanded, onToggle, document }: StepHistoryCardProps) => {
  const [isEditingDocument, setIsEditingDocument] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const handleToggleEdit = () => {
    // Only initialize editedContent from document when entering edit mode and there's no existing draft
    if (!isEditingDocument && document && !editedContent) {
      setEditedContent(document.content.markdown);
    }
    setIsEditingDocument(!isEditingDocument);
    // Don't clear hasChanges when toggling - preserve unsaved drafts
  };

  const handleContentChange = (value: string) => {
    setEditedContent(value);
    setHasChanges(document ? value !== document.content.markdown : false);
  };

  const handleApproveAndContinue = () => {
    console.log("Approved and continuing to next step");
    setHasChanges(false);
    setIsEditingDocument(false);
  };

  return (
    <Card
      blur="md"
      transparency="light"
      edgePosition="left"
      edgeColor={step.isHumanInLoop ? "orange" : "blue"}
      size="md"
      className="overflow-visible"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-gray-900 dark:text-white">{step.stepName}</h4>
            {step.isHumanInLoop && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20">
                <AlertCircle className="w-3 h-3" aria-hidden="true" />
                Human-in-Loop
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{step.timestamp}</p>
        </div>

        {/* Collapse toggle - only show if collapsible */}
        {step.collapsible && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className={cn(
              "px-2 transition-colors",
              step.isHumanInLoop
                ? "text-orange-500 hover:text-orange-600 dark:hover:text-orange-400"
                : "text-cyan-500 hover:text-cyan-600 dark:hover:text-cyan-400",
            )}
            aria-label={isExpanded ? "Collapse step" : "Expand step"}
            aria-expanded={isExpanded}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        )}
      </div>

      {/* Content - collapsible with animation */}
      <AnimatePresence mode="wait">
        {(isExpanded || !step.collapsible) && (
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
          >
            <motion.div
              initial={{ y: -20 }}
              animate={{ y: 0 }}
              exit={{ y: -20 }}
              transition={{
                duration: 0.2,
                ease: "easeOut",
              }}
              className="space-y-3"
            >
              {/* Output content */}
              <div
                className={cn(
                  "p-4 rounded-lg border",
                  step.isHumanInLoop
                    ? "bg-orange-50/50 dark:bg-orange-950/10 border-orange-200/50 dark:border-orange-800/30"
                    : "bg-cyan-50/30 dark:bg-cyan-950/10 border-cyan-200/50 dark:border-cyan-800/30",
                )}
              >
                <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                  {step.output}
                </pre>
              </div>

              {/* Session info */}
              <p
                className={cn(
                  "text-xs font-mono",
                  step.isHumanInLoop ? "text-orange-600 dark:text-orange-400" : "text-cyan-600 dark:text-cyan-400",
                )}
              >
                {step.session}
              </p>

              {/* Review and Approve Plan - only for human-in-loop steps with documents */}
              {step.isHumanInLoop && document && (
                <div className="mt-6 space-y-3">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Review and Approve Plan</h4>

                  {/* Document Card */}
                  <Card blur="md" transparency="light" size="md" className="overflow-visible">
                    {/* View/Edit toggle in top right */}
                    <div className="flex items-center justify-end mb-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleToggleEdit}
                        className="text-gray-600 dark:text-gray-400 hover:bg-gray-500/10"
                        aria-label={isEditingDocument ? "Switch to preview mode" : "Switch to edit mode"}
                      >
                        {isEditingDocument ? (
                          <Eye className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Edit3 className="w-4 h-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>

                    {isEditingDocument ? (
                      <div className="space-y-4">
                        <textarea
                          value={editedContent}
                          onChange={(e) => handleContentChange(e.target.value)}
                          className={cn(
                            "w-full min-h-[300px] p-4 rounded-lg",
                            "bg-white/50 dark:bg-black/30",
                            "border border-gray-300 dark:border-gray-700",
                            "text-gray-900 dark:text-white font-mono text-sm",
                            "focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20",
                            "resize-y",
                          )}
                          placeholder="Enter markdown content..."
                        />
                      </div>
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown
                          components={{
                            h1: ({ node, ...props }) => (
                              <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-3 mt-4" {...props} />
                            ),
                            h2: ({ node, ...props }) => (
                              <h2
                                className="text-lg font-semibold text-gray-900 dark:text-white mb-2 mt-3"
                                {...props}
                              />
                            ),
                            h3: ({ node, ...props }) => (
                              <h3
                                className="text-base font-semibold text-gray-900 dark:text-white mb-2 mt-3"
                                {...props}
                              />
                            ),
                            p: ({ node, ...props }) => (
                              <p className="text-sm text-gray-700 dark:text-gray-300 mb-2 leading-relaxed" {...props} />
                            ),
                            ul: ({ node, ...props }) => (
                              <ul
                                className="list-disc list-inside text-sm text-gray-700 dark:text-gray-300 mb-2 space-y-1"
                                {...props}
                              />
                            ),
                            li: ({ node, ...props }) => <li className="ml-4" {...props} />,
                            code: ({ node, ...props }) => (
                              <code
                                className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono text-orange-600 dark:text-orange-400"
                                {...props}
                              />
                            ),
                          }}
                        >
                          {/* Prefer displaying live draft (editedContent) when non-empty/hasChanges over original document content */}
                          {editedContent && hasChanges ? editedContent : document.content.markdown}
                        </ReactMarkdown>
                      </div>
                    )}

                    {/* Approve button - always visible with glass styling */}
                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200/50 dark:border-gray-700/30">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {hasChanges ? "Unsaved changes" : "No changes"}
                      </p>
                      <Button
                        onClick={handleApproveAndContinue}
                        className={cn(
                          "backdrop-blur-md",
                          "bg-gradient-to-b from-green-100/80 to-white/60",
                          "dark:from-green-500/20 dark:to-green-500/10",
                          "text-green-700 dark:text-green-100",
                          "border border-green-300/50 dark:border-green-500/50",
                          "hover:from-green-200/90 hover:to-green-100/70",
                          "dark:hover:from-green-400/30 dark:hover:to-green-500/20",
                          "hover:shadow-[0_0_20px_rgba(34,197,94,0.5)]",
                          "dark:hover:shadow-[0_0_25px_rgba(34,197,94,0.7)]",
                          "shadow-lg shadow-green-500/20",
                        )}
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2" aria-hidden="true" />
                        Approve and Move to Next Step
                      </Button>
                    </div>
                  </Card>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
};
