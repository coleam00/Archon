import React, { useId } from 'react';
import { Trash2 } from 'lucide-react';

interface DeleteConfirmModalProps {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type: "project" | "task" | "client";
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  itemName,
  onConfirm,
  onCancel,
  type,
}) => {
  const titleId = useId();
  const descId = useId();
  const TITLES: Record<DeleteConfirmModalProps['type'], string> = {
    project: "Delete Project",
    task: "Delete Task",
    client: "Delete MCP Client",
  };

  const MESSAGES: Record<DeleteConfirmModalProps['type'], (n: string) => string> = {
    project: (n) => `Are you sure you want to delete the "${n}" project? This will also delete all associated tasks and documents and cannot be undone.`,
    task:    (n) => `Are you sure you want to delete the "${n}" task? This action cannot be undone.`,
    client:  (n) => `Are you sure you want to delete the "${n}" client? This will permanently remove its configuration and cannot be undone.`,
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      aria-hidden={false}
      data-testid="modal-backdrop"
    >
      <div
        className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-red-500 
          before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 id={titleId} className="text-lg font-semibold text-gray-800 dark:text-white">
                {TITLES[type]}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>

          <p id={descId} className="text-gray-700 dark:text-gray-300 mb-6">
            {MESSAGES[type](itemName)}
          </p>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              autoFocus
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors shadow-lg shadow-red-600/25 hover:shadow-red-700/25"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};