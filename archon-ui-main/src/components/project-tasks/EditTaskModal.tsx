import React, { memo, useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { ArchonLoadingSpinner } from '../animations/Animations';
import { DebouncedInput, FeatureInput } from './TaskInputComponents';
import type { Task } from './TaskTableView';

interface EditTaskModalProps {
  isModalOpen: boolean;
  editingTask: Task | null;
  projectFeatures: any[];
  isLoadingFeatures: boolean;
  isSavingTask: boolean;
  onClose: () => void;
  onSave: (task: Task) => Promise<void>;
  getTasksForPrioritySelection: (status: Task['status']) => Array<{value: number, label: string}>;
}

const ASSIGNEE_OPTIONS = ['User', 'Archon', 'AI IDE Agent'] as const;

// Removed debounce utility - now using DebouncedInput component

export const EditTaskModal = memo(({
  isModalOpen,
  editingTask,
  projectFeatures,
  isLoadingFeatures,
  isSavingTask,
  onClose,
  onSave,
  getTasksForPrioritySelection
}: EditTaskModalProps) => {
  const [localTask, setLocalTask] = useState<Task | null>(null);
  
  // Diagnostic: Track render count
  const renderCount = useRef(0);
  
  useEffect(() => {
    renderCount.current++;
    console.log(`[EditTaskModal] Render #${renderCount.current}`, {
      localTask: localTask?.title,
      isModalOpen,
      timestamp: Date.now()
    });
  });
  
  // Sync local state with editingTask when it changes
  useEffect(() => {
    if (editingTask) {
      setLocalTask(editingTask);
    }
  }, [editingTask]);
  
  const priorityOptions = useMemo(() => {
    console.log(`[EditTaskModal] Recalculating priorityOptions for status: ${localTask?.status || 'todo'}`);
    return getTasksForPrioritySelection(localTask?.status || 'todo');
  }, [localTask?.status, getTasksForPrioritySelection]);

  // Memoized handlers for input changes
  const handleTitleChange = useCallback((value: string) => {
    console.log('[EditTaskModal] Title changed via DebouncedInput:', value);
    setLocalTask(prev => prev ? { ...prev, title: value } : null);
  }, []);
  
  const handleDescriptionChange = useCallback((value: string) => {
    console.log('[EditTaskModal] Description changed via DebouncedInput:', value);
    setLocalTask(prev => prev ? { ...prev, description: value } : null);
  }, []);
  
  const handleFeatureChange = useCallback((value: string) => {
    console.log('[EditTaskModal] Feature changed via FeatureInput:', value);
    setLocalTask(prev => prev ? { ...prev, feature: value } : null);
  }, []);
  
  const handleStatusChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStatus = e.target.value as Task['status'];
    const newOrder = getTasksForPrioritySelection(newStatus)[0]?.value || 1;
    setLocalTask(prev => prev ? { ...prev, status: newStatus, task_order: newOrder } : null);
  }, [getTasksForPrioritySelection]);
  
  const handlePriorityChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalTask(prev => prev ? { ...prev, task_order: parseInt(e.target.value) } : null);
  }, []);
  
  const handleAssigneeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalTask(prev => prev ? {
      ...prev,
      assignee: { name: e.target.value as 'User' | 'Archon' | 'AI IDE Agent', avatar: '' }
    } : null);
  }, []);
  
  const handleSave = useCallback(() => {
    if (localTask) {
      onSave(localTask);
    }
  }, [localTask, onSave]);
  
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!isModalOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-2xl bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border border-gray-200 dark:border-zinc-800/50 shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)] before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] before:rounded-t-[4px] before:bg-gradient-to-r before:from-cyan-500 before:to-fuchsia-500 before:shadow-[0_0_10px_2px_rgba(34,211,238,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)] after:content-[''] after:absolute after:top-0 after:left-0 after:right-0 after:h-16 after:bg-gradient-to-b after:from-cyan-100 after:to-white dark:after:from-cyan-500/20 dark:after:to-fuchsia-500/5 after:rounded-t-md after:pointer-events-none">
        <div className="relative z-10">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-fuchsia-500 text-transparent bg-clip-text">
              {editingTask?.id ? 'Edit Task' : 'New Task'}
            </h3>
            <button onClick={handleClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-gray-700 dark:text-gray-300 mb-1">Title</label>
              <DebouncedInput
                value={localTask?.title || ''}
                onChange={handleTitleChange}
                className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
              />
            </div>

            <div>
              <label className="block text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <DebouncedInput
                value={localTask?.description || ''}
                onChange={handleDescriptionChange}
                type="textarea"
                rows={5}
                className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-700 dark:text-gray-300 mb-1">Status</label>
                <select 
                  value={localTask?.status || 'todo'} 
                  onChange={handleStatusChange}
                  className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
                >
                  <option value="todo">Todo</option>
                  <option value="doing">Doing</option>
                  <option value="review">Review</option>
                  <option value="done">Done</option>
                </select>
              </div>

              <div>
                <label className="block text-gray-700 dark:text-gray-300 mb-1">Priority</label>
                <select 
                  value={localTask?.task_order || 1} 
                  onChange={handlePriorityChange}
                  className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
                >
                  {priorityOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-700 dark:text-gray-300 mb-1">Assignee</label>
                <select 
                  value={localTask?.assignee?.name || 'User'} 
                  onChange={handleAssigneeChange}
                  className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
                >
                  {ASSIGNEE_OPTIONS.map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-gray-700 dark:text-gray-300 mb-1">Feature</label>
                <FeatureInput
                  value={localTask?.feature || ''}
                  onChange={handleFeatureChange}
                  projectFeatures={projectFeatures}
                  isLoadingFeatures={isLoadingFeatures}
                  placeholder="Type feature name"
                  className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-white rounded-md py-2 px-3 pr-10 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] transition-all duration-300"
                />
              </div>
            </div>
          </div>


          <div className="flex justify-end gap-3 mt-6">
            <Button onClick={handleClose} variant="ghost" disabled={isSavingTask}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              variant="primary" 
              accentColor="cyan" 
              className="shadow-lg shadow-cyan-500/20"
              disabled={isSavingTask}
            >
              {isSavingTask ? (
                <span className="flex items-center">
                  <ArchonLoadingSpinner size="sm" className="mr-2" />
                  {localTask?.id ? 'Saving...' : 'Creating...'}
                </span>
              ) : (
                localTask?.id ? 'Save Changes' : 'Create Task'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function to prevent unnecessary re-renders
  // Only re-render if these specific props change
  const isEqual = (
    prevProps.isModalOpen === nextProps.isModalOpen &&
    prevProps.editingTask?.id === nextProps.editingTask?.id &&
    prevProps.editingTask?.title === nextProps.editingTask?.title &&
    prevProps.editingTask?.description === nextProps.editingTask?.description &&
    prevProps.editingTask?.status === nextProps.editingTask?.status &&
    prevProps.editingTask?.assignee?.name === nextProps.editingTask?.assignee?.name &&
    prevProps.editingTask?.feature === nextProps.editingTask?.feature &&
    prevProps.editingTask?.task_order === nextProps.editingTask?.task_order &&
    prevProps.isSavingTask === nextProps.isSavingTask &&
    prevProps.isLoadingFeatures === nextProps.isLoadingFeatures &&
    prevProps.projectFeatures === nextProps.projectFeatures // Reference equality check
  );
  
  if (!isEqual) {
    console.log('[EditTaskModal] Props changed, re-rendering');
  }
  
  return isEqual;
});

EditTaskModal.displayName = 'EditTaskModal';