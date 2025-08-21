import React from 'react';
import { Trash2 } from 'lucide-react';

export interface DeleteConfirmModalProps {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type: 'project' | 'task' | 'client' | 'document' | 'knowledge-items' | 'feature' | 'data';
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ itemName, onConfirm, onCancel, type }) => {
  const getTitle = () => {
    switch (type) {
      case 'project': return 'Delete Project';
      case 'task': return 'Delete Task';
      case 'client': return 'Delete MCP Client';
      case 'document': return 'Delete Document';
      case 'knowledge-items': return 'Delete Knowledge Items';
      case 'feature': return 'Delete Feature';
      case 'data': return 'Delete Data';
    }
  };

  const getMessage = () => {
    switch (type) {
      case 'project': return `Are you sure you want to delete the "${itemName}" project? This will also delete all associated tasks and documents and cannot be undone.`;
      case 'task': return `Are you sure you want to delete the "${itemName}" task? This action cannot be undone.`;
      case 'client': return `Are you sure you want to delete the "${itemName}" client? This will permanently remove its configuration and cannot be undone.`;
      case 'document': return `Are you sure you want to delete the "${itemName}" document? This action cannot be undone.`;
      case 'knowledge-items': return `Are you sure you want to delete ${itemName}? This will permanently remove the selected items from your knowledge base and cannot be undone.`;
      case 'feature': return `Are you sure you want to delete the "${itemName}" feature? This action cannot be undone.`;
      case 'data': return `Are you sure you want to delete this data? This action cannot be undone.`;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-red-500 
          before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]">
        
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                {getTitle()}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>
          
          <p className="text-gray-700 dark:text-gray-300 mb-6">
            {getMessage()}
          </p>
          
          <div className="flex justify-end gap-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors shadow-lg shadow-red-600/20"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};