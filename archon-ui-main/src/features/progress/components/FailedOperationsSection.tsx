/**
 * Failed Operations Section Component
 * Displays persistent error states with retry/remove actions
 */

import { AlertCircle, ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { useRetryKnowledgeSource } from "../../knowledge/hooks/useRetryKnowledgeSource";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Button } from "../../ui/primitives/button";
import {
	useFailedOperations,
	useRemoveFailedOperation,
} from "../hooks/useProgressQueries";
import type { FailedOperation } from "../types";

export function FailedOperationsSection() {
  const { data: failedOps, isLoading } = useFailedOperations();
  const retryMutation = useRetryKnowledgeSource();
  const removeMutation = useRemoveFailedOperation();
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<FailedOperation | null>(null);

  const toggleExpanded = (progressId: string) => {
    setExpandedOps((prev) => {
      const next = new Set(prev);
      if (next.has(progressId)) {
        next.delete(progressId);
      } else {
        next.add(progressId);
      }
      return next;
    });
  };

  if (isLoading) {
    return <div className="text-gray-400">Loading failed operations...</div>;
  }

  if (!failedOps?.operations.length) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex items-center gap-2">
        <AlertCircle className="h-5 w-5 text-red-400" />
        <h3 className="text-lg font-semibold text-white">Failed Operations</h3>
        <span className="ml-2 px-2 py-0.5 bg-red-500/20 text-red-400 text-xs font-semibold rounded-full">
          {failedOps.count}
        </span>
      </div>

      {/* Failed Operations List */}
      <div className="space-y-3">
        {failedOps.operations.map((op) => (
          <div key={op.progressId} className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 backdrop-blur-sm">
            {/* Operation Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                  <p className="text-sm font-medium text-red-400 truncate">
                    {op.url || op.currentUrl || "Unknown URL"}
                  </p>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Failed {op.error_time ? new Date(op.error_time).toLocaleString() : "recently"}
                </p>
                {/* Error Message Preview */}
                <p className="text-sm text-gray-300 mt-2 line-clamp-2">{op.error || "Unknown error"}</p>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggleExpanded(op.progressId)}
                  className="text-gray-400 hover:text-white"
                >
                  {expandedOps.has(op.progressId) ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => retryMutation.mutate(op)}
                  disabled={retryMutation.isPending}
                  className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmRemove(op)}
                  className="text-red-400 hover:bg-red-500/10"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Expanded Error Details */}
            {expandedOps.has(op.progressId) && (
              <div className="mt-4 border-t border-red-500/20 pt-4">
                <h4 className="text-sm font-medium text-gray-300 mb-2">Full Error Message:</h4>
                <pre className="text-xs text-gray-400 bg-black/20 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                  {op.error}
                </pre>

                {op.logs && op.logs.length > 0 && (
                  <>
                    <h4 className="text-sm font-medium text-gray-300 mb-2 mt-4">Crawl Logs:</h4>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {op.logs
                        .slice(-10)
                        .filter((log): log is { timestamp: string; message: string } => typeof log !== "string")
                        .map((log) => (
                          <div key={log.timestamp} className="text-xs text-gray-400">
                            <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                            {" - "}
                            {log.message}
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Remove Confirmation Modal */}
      {confirmRemove && (
        <DeleteConfirmModal
          type="knowledge"
          itemName={confirmRemove.url || "this operation"}
          onConfirm={() => {
            removeMutation.mutate(confirmRemove.progressId);
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}
