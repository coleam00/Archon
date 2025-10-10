import { useState } from 'react';
import { InspectorDialog, InspectorDialogContent, InspectorDialogTitle } from '@/features/ui/primitives/inspector-dialog';
import { Button } from '@/features/ui/primitives/button';
import { OllamaInstanceList } from './OllamaInstanceList';
import { OllamaInstanceDetails } from './OllamaInstanceDetails';
import { AddInstanceModal } from './AddInstanceModal';
import { useInstances, useSetModel, useTestConnection, useDeleteInstance } from '../hooks/useOllamaQueries';

interface ModelsConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ModelsConfigDialog = ({ open, onOpenChange }: ModelsConfigDialogProps) => {
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const { data: instances = [], isLoading } = useInstances();
  const setModelMutation = useSetModel();
  const testConnectionMutation = useTestConnection();
  const deleteInstanceMutation = useDeleteInstance();

  const selectedInstance = instances.find(inst => inst.id === selectedInstanceId);

  const handleSetModel = async (modelType: 'chat' | 'embedding') => {
    if (!selectedInstanceId) return;

    await setModelMutation.mutateAsync({
      instanceId: selectedInstanceId,
      modelType
    });

    onOpenChange(false);
  };

  const handleTestConnection = async () => {
    if (!selectedInstance) return;
    await testConnectionMutation.mutateAsync(selectedInstance.baseUrl);
  };

  const handleDelete = async () => {
    if (!selectedInstanceId) return;
    await deleteInstanceMutation.mutateAsync(selectedInstanceId);
    setSelectedInstanceId(null);
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <>
      <InspectorDialog open={open} onOpenChange={onOpenChange}>
        <InspectorDialogContent>
          <InspectorDialogTitle>Configure Models</InspectorDialogTitle>

          <div className="px-6 py-4 bg-blue-500/10 border-b border-white/10">
            <p className="text-sm text-blue-200">
              Configure AI models for chat and embeddings. Select an Ollama instance and set it as your active model.
            </p>
          </div>

          <div className="flex flex-1 min-h-0">
            <div className="w-64 border-r border-white/10 p-4 overflow-y-auto">
              <OllamaInstanceList
                instances={instances}
                selectedId={selectedInstanceId}
                onSelect={setSelectedInstanceId}
                onAdd={() => setAddModalOpen(true)}
                isLoading={isLoading}
              />
            </div>

            <div className="flex-1 p-6 overflow-y-auto">
              {selectedInstance ? (
                <OllamaInstanceDetails
                  instance={selectedInstance}
                  onTestConnection={handleTestConnection}
                  onDelete={handleDelete}
                  isTesting={testConnectionMutation.isPending}
                  isDeleting={deleteInstanceMutation.isPending}
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-gray-400">Select an instance to view details</p>
                </div>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 px-6 py-4 border-t border-white/10 flex justify-between">
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
            {selectedInstanceId && (
              <div className="flex gap-2">
                <Button
                  onClick={() => handleSetModel('chat')}
                  disabled={setModelMutation.isPending}
                >
                  Set as Chat Model
                </Button>
                <Button
                  onClick={() => handleSetModel('embedding')}
                  disabled={setModelMutation.isPending}
                >
                  Set as Embedding Model
                </Button>
              </div>
            )}
          </div>
        </InspectorDialogContent>
      </InspectorDialog>

      <AddInstanceModal
        open={addModalOpen}
        onOpenChange={setAddModalOpen}
      />
    </>
  );
};
