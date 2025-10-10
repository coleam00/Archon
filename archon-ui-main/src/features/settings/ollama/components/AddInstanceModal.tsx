import { Loader2 } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/primitives/dialog";
import { Input, Label, FormField } from "@/features/ui/primitives/input";
import { RadioGroup, RadioGroupItem } from "@/features/ui/primitives/radio-group";
import { cn } from "@/features/ui/primitives/styles";
import { useCreateInstance } from "../hooks/useOllamaQueries";
import type { OllamaInstance } from "../types";

interface AddInstanceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export const AddInstanceModal: React.FC<AddInstanceModalProps> = ({ open, onOpenChange, onSuccess }) => {
  const nameId = useId();
  const urlId = useId();

  const [formData, setFormData] = useState<Omit<OllamaInstance, 'id'>>({
    name: "",
    baseUrl: "",
    isEnabled: true,
    isPrimary: false,
    instanceType: 'both',
  });

  const createInstanceMutation = useCreateInstance();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.baseUrl.trim()) return;

    createInstanceMutation.mutate(formData, {
      onSuccess: () => {
        setFormData({
          name: "",
          baseUrl: "",
          isEnabled: true,
          isPrimary: false,
          instanceType: 'both',
        });
        onOpenChange(false);
        onSuccess?.();
      },
    });
  };

  const handleClose = () => {
    if (!createInstanceMutation.isPending) {
      setFormData({
        name: "",
        baseUrl: "",
        isEnabled: true,
        isPrimary: false,
        instanceType: 'both',
      });
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 text-transparent bg-clip-text">
              Add Ollama Instance
            </DialogTitle>
            <DialogDescription>Connect to an Ollama server by providing its URL</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            <FormField>
              <Label htmlFor={nameId}>Instance Name</Label>
              <Input
                id={nameId}
                type="text"
                placeholder="Local Server"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                disabled={createInstanceMutation.isPending}
                autoFocus
              />
            </FormField>

            <FormField>
              <Label htmlFor={urlId}>Server URL</Label>
              <Input
                id={urlId}
                type="url"
                placeholder="http://localhost:11434"
                value={formData.baseUrl}
                onChange={(e) => setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))}
                disabled={createInstanceMutation.isPending}
              />
            </FormField>

            <FormField>
              <Label>Instance Type</Label>
              <RadioGroup
                value={formData.instanceType}
                onValueChange={(value) => setFormData((prev) => ({ ...prev, instanceType: value as 'chat' | 'embedding' | 'both' }))}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="both" id="both" />
                  <Label htmlFor="both" className="font-normal cursor-pointer">Both (Chat & Embedding)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="chat" id="chat" />
                  <Label htmlFor="chat" className="font-normal cursor-pointer">Chat Only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="embedding" id="embedding" />
                  <Label htmlFor="embedding" className="font-normal cursor-pointer">Embedding Only</Label>
                </div>
              </RadioGroup>
            </FormField>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={createInstanceMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={createInstanceMutation.isPending || !formData.name.trim() || !formData.baseUrl.trim()}
            >
              {createInstanceMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                "Add Instance"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
