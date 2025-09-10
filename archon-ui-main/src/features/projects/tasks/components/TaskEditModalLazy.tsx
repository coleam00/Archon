import { lazy, Suspense, useEffect, useState } from "react";
import type { Task } from "../types";

// Lazy load the heavy modal component
const TaskEditModal = lazy(() =>
  import("./TaskEditModal").then((module) => ({ default: module.TaskEditModal }))
);

interface TaskEditModalLazyProps {
  isModalOpen: boolean;
  editingTask: Task | null;
  projectId: string;
  onClose: () => void;
  onSaved?: () => void;
  onOpenChange?: (open: boolean) => void;
}

// Loading fallback component that matches modal dimensions to prevent layout shift
const LoadingFallback = () => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="relative w-full max-w-2xl rounded-lg border bg-background p-6 shadow-lg">
      <div className="flex flex-col space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-20 w-full animate-pulse rounded bg-muted" />
        <div className="mt-6 flex justify-end space-x-2">
          <div className="h-9 w-20 animate-pulse rounded bg-muted" />
          <div className="h-9 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  </div>
);

export function TaskEditModalLazy(props: TaskEditModalLazyProps) {
  const [shouldPreload, setShouldPreload] = useState(false);
  
  // Progressive enhancement: Preload on hover/focus of trigger buttons
  useEffect(() => {
    if (!shouldPreload) return;
    
    // Trigger lazy loading in background
    import("./TaskEditModal").catch(console.error);
  }, [shouldPreload]);
  
  // Expose preload trigger via data attribute on parent
  useEffect(() => {
    const handlePreload = () => setShouldPreload(true);
    
    // Find buttons that might trigger this modal
    const triggerButtons = document.querySelectorAll('[data-preload-task-modal="true"]');
    triggerButtons.forEach(btn => {
      btn.addEventListener('mouseenter', handlePreload);
      btn.addEventListener('focus', handlePreload);
    });
    
    return () => {
      triggerButtons.forEach(btn => {
        btn.removeEventListener('mouseenter', handlePreload);
        btn.removeEventListener('focus', handlePreload);
      });
    };
  }, []);
  
  // Only render when modal is actually needed
  if (!props.isModalOpen) {
    return null;
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      <TaskEditModal {...props} />
    </Suspense>
  );
}