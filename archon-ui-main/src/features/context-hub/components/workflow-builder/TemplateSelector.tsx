/**
 * Template Selector Component
 *
 * Modal/dropdown for selecting a step template of a specific type.
 * Used when clicking on a blank template selector node.
 */

import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/primitives/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { Label } from "@/features/ui/primitives/label";
import { useStepTemplates } from "../../hooks/useStepTemplates";
import type { StepType, StepTemplate } from "../../types";

interface TemplateSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stepType: StepType;
  onSelect: (template: StepTemplate) => void;
}

export function TemplateSelector({ open, onOpenChange, stepType, onSelect }: TemplateSelectorProps) {
  const { data: templates } = useStepTemplates(stepType, true, true);
  const [selectedSlug, setSelectedSlug] = useState<string>("");

  const handleSelect = () => {
    const template = templates?.find((t) => t.slug === selectedSlug);
    if (template) {
      onSelect(template);
      setSelectedSlug("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select {stepType.charAt(0).toUpperCase() + stepType.slice(1)} Template</DialogTitle>
          <DialogDescription>Choose a step template for this {stepType} step.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label htmlFor="template-select">Template</Label>
            <Select value={selectedSlug} onValueChange={setSelectedSlug}>
              <SelectTrigger id="template-select" className="w-full mt-2">
                <SelectValue placeholder="Select a template..." />
              </SelectTrigger>
              <SelectContent>
                {templates && templates.length > 0 ? (
                  templates.map((template) => (
                    <SelectItem key={template.slug} value={template.slug}>
                      {template.name}
                      {template.description && ` - ${template.description}`}
                    </SelectItem>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-sm text-gray-500">No templates available</div>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSelect} disabled={!selectedSlug} variant="cyan">
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

