import { Trash2 } from "lucide-react";
import type React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../primitives/alert-dialog";
import { Button } from "../primitives/button";
import { cn } from "../primitives/styles";

interface DeleteConfirmModalProps {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type: "project" | "task" | "client" | "document" | "knowledge";
  size?: "compact" | "default" | "large";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  itemName,
  onConfirm,
  onCancel,
  type,
  size = "default",
  open = false,
  onOpenChange,
}) => {
  const TITLES: Record<DeleteConfirmModalProps["type"], string> = {
    project: "Delete Project",
    task: "Delete Task",
    client: "Delete MCP Client",
    document: "Delete Document",
    knowledge: "Delete Knowledge Item",
  };

  const MESSAGES: Record<DeleteConfirmModalProps["type"], (_n: string) => string> = {
    project: (_n) => `Are you sure you want to delete this project?`,
    task: (_n) => `Are you sure you want to delete this task?`,
    client: (_n) => `Are you sure you want to delete this client?`,
    document: (_n) => `Are you sure you want to delete this document?`,
    knowledge: (n) =>
      `Are you sure you want to delete "${n}"? All associated documents and code examples will be permanently removed.`,
  };

  // Size-specific styling for icon
  const getIconStyles = () => {
    switch (size) {
      case "compact":
        return { container: "w-8 h-8", icon: "w-4 h-4" };
      case "large":
        return { container: "w-16 h-16", icon: "w-8 h-8" };
      default:
        return { container: "w-12 h-12", icon: "w-6 h-6" };
    }
  };

  const iconStyles = getIconStyles();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        variant="destructive"
        className={cn(
          size === "compact" && "max-w-sm",
          size === "large" && "max-w-lg",
          !size || (size === "default" && "max-w-md"),
        )}
      >
        <AlertDialogHeader>
          <div className={`flex items-center gap-3 ${size === "compact" ? "mb-2" : "mb-3"}`}>
            <div
              className={cn(
                iconStyles.container,
                "rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center",
              )}
            >
              <Trash2 className={cn(iconStyles.icon, "text-red-600 dark:text-red-400")} />
            </div>
            <div>
              <AlertDialogTitle
                className={cn(
                  size === "compact" && "text-base",
                  size === "large" && "text-xl",
                  !size || (size === "default" && "text-lg"),
                )}
              >
                {TITLES[type]}
              </AlertDialogTitle>
              <AlertDialogDescription
                className={cn(
                  size === "compact" && "text-xs",
                  size === "large" && "text-base",
                  !size || (size === "default" && "text-sm"),
                )}
              >
                This action cannot be undone
              </AlertDialogDescription>
            </div>
          </div>
          <p
            className={cn(
              "text-gray-700 dark:text-gray-300 mt-2 mb-4",
              size === "compact" && "text-sm mb-3",
              size === "large" && "text-base mb-5",
              !size || (size === "default" && "text-base mb-4"),
            )}
          >
            {MESSAGES[type](itemName)}
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              onClick={onCancel}
              variant="outline"
              size={size === "compact" ? "sm" : size === "large" ? "lg" : "default"}
            >
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              onClick={onConfirm}
              variant="destructive"
              size={size === "compact" ? "sm" : size === "large" ? "lg" : "default"}
            >
              Delete
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
