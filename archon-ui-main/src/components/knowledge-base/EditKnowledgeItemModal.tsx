import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X, Save, RefreshCw, Users, UserX } from 'lucide-react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { KnowledgeItem } from '../../services/knowledgeBaseService';
import { knowledgeBaseService } from '../../services/knowledgeBaseService';
import { useToast } from '../../contexts/ToastContext';
import { EditableTags } from './EditableTags';

interface EditKnowledgeItemModalProps {
  item: KnowledgeItem;
  onClose: () => void;
  onUpdate: () => void;
}

export const EditKnowledgeItemModal: React.FC<EditKnowledgeItemModalProps> = ({
  item,
  onClose,
  onUpdate,
}) => {
  const { showToast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isRemovingFromGroup, setIsRemovingFromGroup] = useState(false);
  const [formData, setFormData] = useState({
    title: item.title,
    description: item.metadata?.description || '',
    tags: item.metadata?.tags || [],
  });
  const [isUpdatingTags, setIsUpdatingTags] = useState(false);

  const isInGroup = Boolean(item.metadata?.group_name);

  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.title.trim()) {
      showToast('Title is required', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      // Update the knowledge item
      const updates: any = {};
      
      // Only include title if it has changed
      if (formData.title !== item.title) {
        updates.title = formData.title;
      }
      
      // Only include description if it has changed
      if (formData.description !== (item.metadata?.description || '')) {
        updates.description = formData.description;
      }

      // Only include tags if they have changed (using immutable comparison)
      const originalTags = item.metadata?.tags || [];
      const sortedFormTags = [...formData.tags].sort();
      const sortedOriginalTags = [...originalTags].sort();
      const tagsChanged = JSON.stringify(sortedFormTags) !== JSON.stringify(sortedOriginalTags);
      if (tagsChanged) {
        updates.tags = formData.tags;
      }
      
      await knowledgeBaseService.updateKnowledgeItem(item.source_id, updates);
      
      showToast('Knowledge item updated successfully', 'success');
      onUpdate();
      onClose();
    } catch (error) {
      console.error('Failed to update knowledge item:', error);
      showToast(`Failed to update: ${(error as any)?.message || 'Unknown error'}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTagsUpdate = async (tags: string[]) => {
    setIsUpdatingTags(true);
    try {
      setFormData(prev => ({ ...prev, tags }));
    } catch (error) {
      const errorMessage = error instanceof Error 
        ? `Failed to update tags: ${error.message}` 
        : 'Failed to update tags: Unknown error occurred';
      
      console.error('Tag update error:', error);
      showToast(errorMessage, 'error');
      throw error;
    } finally {
      setIsUpdatingTags(false);
    }
  };

  const handleTagError = (error: string) => {
    showToast(error, 'error');
  };

  const handleRemoveFromGroup = async () => {
    if (!isInGroup) return;
    
    setIsRemovingFromGroup(true);
    
    try {
      const currentGroupName = item.metadata?.group_name;
      if (!currentGroupName) {
        throw new Error('No group name found');
      }

      // Get all knowledge items to find other items in the same group
      const allItemsResponse = await knowledgeBaseService.getKnowledgeItems({ per_page: 1000 });
      const itemsInGroup = allItemsResponse.items.filter(
        knowledgeItem => knowledgeItem.metadata?.group_name === currentGroupName
      );

      console.log(`Found ${itemsInGroup.length} items in group "${currentGroupName}"`);

      if (itemsInGroup.length <= 2) {
        // If there are only 2 items in the group, remove group_name from both
        // This dissolves the group entirely
        showToast('Dissolving group with 2 or fewer items...', 'info');
        
        for (const groupItem of itemsInGroup) {
          await knowledgeBaseService.updateKnowledgeItem(groupItem.source_id, {
            group_name: ""
          });
        }
        
        showToast('Group dissolved - all items are now individual', 'success');
      } else {
        // If there are 3+ items, only remove this item from the group
        await knowledgeBaseService.updateKnowledgeItem(item.source_id, {
          group_name: ""
        });
        
        showToast('Item removed from group successfully', 'success');
      }
      
      onUpdate();
      onClose();
    } catch (error) {
      console.error('Failed to remove from group:', error);
      showToast(`Failed to remove from group: ${(error as any)?.message || 'Unknown error'}`, 'error');
    } finally {
      setIsRemovingFromGroup(false);
    }
  };

  // Using React Portal to render the modal at the root level
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="relative w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pink accent line at the top */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-pink-500 to-purple-500 shadow-[0_0_20px_5px_rgba(236,72,153,0.5)] z-10 rounded-t-xl"></div>
        
        <Card className="relative overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-800 dark:text-white">
              Edit Knowledge Item
            </h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Title"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="Enter title"
              accentColor="pink"
              disabled={isLoading}
            />

            {/* Description field */}
            <div className="w-full">
              <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-1.5">
                Description
              </label>
              <div className="backdrop-blur-md bg-gradient-to-b dark:from-white/10 dark:to-black/30 from-white/80 to-white/60 border dark:border-zinc-800/80 border-gray-200 rounded-md px-3 py-2 transition-all duration-200 focus-within:border-pink-500 focus-within:shadow-[0_0_15px_rgba(236,72,153,0.5)]">
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Enter description (optional)"
                  disabled={isLoading}
                  rows={3}
                  className="w-full bg-transparent text-gray-800 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 focus:outline-none resize-none"
                />
              </div>
            </div>

            {/* Tags field */}
            <div className="w-full">
              <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-1.5">
                Tags
              </label>
              <div className="backdrop-blur-md bg-gradient-to-b dark:from-white/10 dark:to-black/30 from-white/80 to-white/60 border dark:border-zinc-800/80 border-gray-200 rounded-md px-3 py-2 transition-all duration-200 focus-within:border-pink-500 focus-within:shadow-[0_0_15px_rgba(236,72,153,0.5)]">
                <EditableTags
                  tags={formData.tags}
                  onTagsUpdate={handleTagsUpdate}
                  maxVisibleTags={10}
                  isUpdating={isUpdatingTags}
                  onError={handleTagError}
                />
              </div>
            </div>

            {/* Group info and remove button */}
            {isInGroup && (
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <div>
                      <div className="text-sm font-medium text-blue-800 dark:text-blue-200">
                        Grouped Item
                      </div>
                      <div className="text-xs text-blue-600 dark:text-blue-400">
                        Group: {item.metadata.group_name}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveFromGroup}
                    disabled={isRemovingFromGroup || isLoading}
                    className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-900/20"
                  >
                    {isRemovingFromGroup ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                        Removing...
                      </>
                    ) : (
                      <>
                        <UserX className="w-3 h-3 mr-1" />
                        Remove from Group
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Additional info */}
            <div className="bg-gray-100 dark:bg-zinc-800 rounded-lg p-3 space-y-1">
              <div className="text-sm text-gray-600 dark:text-zinc-400">
                <span className="font-medium">Source:</span> {item.url}
              </div>
              <div className="text-sm text-gray-600 dark:text-zinc-400">
                <span className="font-medium">Type:</span> {item.metadata.source_type === 'url' ? 'URL' : 'File'}
              </div>
              <div className="text-sm text-gray-600 dark:text-zinc-400">
                <span className="font-medium">Last Updated:</span> {new Date(item.updated_at).toLocaleString()}
              </div>
            </div>

            {/* Buttons */}
            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isLoading || isRemovingFromGroup}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                accentColor="pink"
                disabled={isLoading || isRemovingFromGroup}
                className="flex items-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </form>
        </Card>
      </motion.div>
    </motion.div>,
    document.body
  );
};