import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/primitives";
import type { CreateSprintRequest, SprintStatus } from "../types";

interface NewSprintModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSubmit: (data: CreateSprintRequest) => void;
  isSubmitting?: boolean;
}

export function NewSprintModal({ open, onOpenChange, projectId, onSubmit, isSubmitting }: NewSprintModalProps) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [status, setStatus] = useState<SprintStatus>("planning");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const reset = () => {
    setName("");
    setGoal("");
    setStatus("planning");
    setStartDate("");
    setEndDate("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    onSubmit({
      project_id: projectId,
      name: name.trim(),
      goal: goal.trim() || undefined,
      status,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    });

    reset();
    onOpenChange(false);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Sprint</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="sprint-name">Name *</Label>
            <Input
              id="sprint-name"
              placeholder="Sprint 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sprint-goal">Goal</Label>
            <Input
              id="sprint-goal"
              placeholder="What should this sprint achieve?"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sprint-status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as SprintStatus)}>
              <SelectTrigger id="sprint-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="planning">Planning</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sprint-start">Start Date</Label>
              <Input id="sprint-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sprint-end">End Date</Label>
              <Input id="sprint-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Sprint"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
