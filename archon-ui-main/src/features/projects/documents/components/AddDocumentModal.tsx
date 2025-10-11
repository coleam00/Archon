import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/primitives";

interface AddDocumentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (title: string, type: string) => Promise<void>;
}

export const AddDocumentModal = ({ open, onOpenChange, onAdd }: AddDocumentModalProps) => {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("spec");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form state when modal closes
  useEffect(() => {
    if (!open) {
      setTitle("");
      setType("spec");
      setError(null);
      setIsAdding(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsAdding(true);
    setError(null);

    try {
      await onAdd(title, type);
      setTitle("");
      setType("spec");
      setError(null);
      onOpenChange(false);
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Failed to create document"
      );
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add New Document</DialogTitle>
            <DialogDescription>Create a new document for this project</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <div>
              <label htmlFor="document-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Document Title
              </label>
              <Input
                id="document-title"
                type="text"
                placeholder="Enter document title..."
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isAdding}
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="document-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Document Type
              </label>
              <Select value={type} onValueChange={setType} disabled={isAdding}>
                <SelectTrigger className="w-full" color="cyan">
                  <SelectValue placeholder="Select a document type" />
                </SelectTrigger>
                <SelectContent color="cyan">
                  <SelectItem value="spec" color="cyan">Specification</SelectItem>
                  <SelectItem value="api" color="cyan">API Documentation</SelectItem>
                  <SelectItem value="guide" color="cyan">Guide</SelectItem>
                  <SelectItem value="note" color="cyan">Note</SelectItem>
                  <SelectItem value="design" color="cyan">Design</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isAdding}>
              Cancel
            </Button>
            <Button type="submit" variant="default" disabled={isAdding || !title.trim()}>
              {isAdding ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                "Add Document"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
