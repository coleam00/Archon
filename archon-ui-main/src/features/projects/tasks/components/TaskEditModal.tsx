import { memo, useCallback, useEffect, useState } from "react";
import {
  Button,
  ComboBox,
  type ComboBoxOption,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  FormGrid,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextArea,
} from "../../../ui/primitives";
import { useTaskEditor } from "../hooks";
import { type Assignee, COMMON_ASSIGNEES, type Task, type TaskPriority } from "../types";
import { FeatureSelect } from "./FeatureSelect";

interface TaskEditModalProps {
  isModalOpen: boolean;
  editingTask: Task | null;
  projectId: string;
  onClose: () => void;
  onSaved?: () => void;
  onOpenChange?: (open: boolean) => void;
}

// Convert common assignees to ComboBox options
const ASSIGNEE_OPTIONS: ComboBoxOption[] = COMMON_ASSIGNEES.map((name) => ({
  value: name,
  label: name,
  description:
    name === "User" ? "Assign to human user" : name === "Archon" ? "Assign to Archon system" : "Assign to Coding Agent",
}));

export const TaskEditModal = memo(
  ({ isModalOpen, editingTask, projectId, onClose, onSaved, onOpenChange }: TaskEditModalProps) => {
    const [localTask, setLocalTask] = useState<Partial<Task> | null>(null);

    // Use business logic hook
    const { projectFeatures, saveTask, isLoadingFeatures, isSaving: isSavingTask } = useTaskEditor(projectId);

    // Sync local state with editingTask when it changes
    useEffect(() => {
      if (editingTask) {
        setLocalTask(editingTask);
      } else {
        // Reset for new task
        setLocalTask({
          title: "",
          description: "",
          status: "todo",
          assignee: "User" as Assignee,
          feature: "",
          priority: "medium" as TaskPriority, // Direct priority field
        });
      }
    }, [editingTask]);

    // Memoized handlers for input changes
    const handleTitleChange = useCallback((value: string) => {
      setLocalTask((prev) => (prev ? { ...prev, title: value } : null));
    }, []);

    const handleDescriptionChange = useCallback((value: string) => {
      setLocalTask((prev) => (prev ? { ...prev, description: value } : null));
    }, []);

    const handleFeatureChange = useCallback((value: string) => {
      setLocalTask((prev) => (prev ? { ...prev, feature: value } : null));
    }, []);

    const handleSave = useCallback(() => {
      // All validation is now in the hook
      saveTask(localTask, editingTask, () => {
        onSaved?.();
        onClose();
      });
    }, [localTask, editingTask, saveTask, onSaved, onClose]);

    const handleClose = useCallback(() => {
      onClose();
    }, [onClose]);

    return (
      <Dialog open={isModalOpen} onOpenChange={onOpenChange || ((open) => !open && onClose())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingTask?.id ? "Edit Task" : "New Task"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <FormField>
              <Label required>Title</Label>
              <Input
                value={localTask?.title || ""}
                onChange={(e) => handleTitleChange(e.target.value)}
                placeholder="Enter task title"
              />
            </FormField>

            <FormField>
              <Label>Description</Label>
              <TextArea
                value={localTask?.description || ""}
                onChange={(e) => handleDescriptionChange(e.target.value)}
                rows={5}
                placeholder="Enter task description"
              />
            </FormField>

            <FormGrid columns={2}>
              <FormField>
                <Label>Status</Label>
                <Select
                  value={localTask?.status || "todo"}
                  onValueChange={(value) =>
                    setLocalTask((prev) => (prev ? { ...prev, status: value as Task["status"] } : null))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">Todo</SelectItem>
                    <SelectItem value="doing">Doing</SelectItem>
                    <SelectItem value="review">Review</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField>
                <Label>Priority</Label>
                <Select
                  value={localTask?.priority || "medium"}
                  onValueChange={(value) =>
                    setLocalTask((prev) => (prev ? { ...prev, priority: value as TaskPriority } : null))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="critical">Critical</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </FormGrid>

            <FormGrid columns={2}>
              <FormField>
                <Label>Assignee</Label>
                <ComboBox
                  options={ASSIGNEE_OPTIONS}
                  value={localTask?.assignee || "User"}
                  onValueChange={(value) => setLocalTask((prev) => (prev ? { ...prev, assignee: value } : null))}
                  placeholder="Select or type assignee..."
                  searchPlaceholder="Search or enter custom..."
                  emptyMessage="Type a custom assignee name"
                  className="w-full"
                  allowCustomValue={true}
                />
              </FormField>

              <FormField>
                <Label>Feature</Label>
                <FeatureSelect
                  value={localTask?.feature || ""}
                  onChange={handleFeatureChange}
                  projectFeatures={projectFeatures}
                  isLoadingFeatures={isLoadingFeatures}
                  placeholder="Select or create feature..."
                  className="w-full"
                />
              </FormField>
            </FormGrid>
          </div>

          <DialogFooter>
            <Button onClick={handleClose} variant="outline" disabled={isSavingTask}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              variant="cyan"
              loading={isSavingTask}
              disabled={isSavingTask || !localTask?.title}
            >
              {editingTask?.id ? "Update Task" : "Create Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);

TaskEditModal.displayName = "TaskEditModal";
