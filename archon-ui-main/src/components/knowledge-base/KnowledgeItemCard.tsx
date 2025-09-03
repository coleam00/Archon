import { useState } from 'react';
import { Link as LinkIcon, Upload, Trash2, RefreshCw, Code, FileText, Brain, BoxIcon, Pencil } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import { KnowledgeItem, knowledgeBaseService } from '../../services/knowledgeBaseService';
import { useCardTilt } from '../../hooks/useCardTilt';
import { CodeViewerModal, CodeExample } from '../code/CodeViewerModal';
import { EditKnowledgeItemModal } from './EditKnowledgeItemModal';
import '../../styles/card-animations.css';

// Helper function to guess language from title
const guessLanguageFromTitle = (title: string = ''): string => {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('javascript') || titleLower.includes('js')) return 'javascript';
  if (titleLower.includes('typescript') || titleLower.includes('ts')) return 'typescript';
  if (titleLower.includes('react')) return 'jsx';
  if (titleLower.includes('html')) return 'html';
  if (titleLower.includes('css')) return 'css';
  if (titleLower.includes('python')) return 'python';
  if (titleLower.includes('java')) return 'java';
  return 'javascript'; // Default
};

// Tags display component
interface TagsDisplayProps {
  tags: string[];
}

const TagsDisplay = ({ tags }: TagsDisplayProps) => {
  const [showTooltip, setShowTooltip] = useState(false);
  
  if (!tags || tags.length === 0) return null;
  
  const visibleTags = tags.slice(0, 4);
  const remainingTags = tags.slice(4);
  const hasMoreTags = remainingTags.length > 0;
  
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2 h-full">
        {visibleTags.map((tag, index) => (
          <Badge
            key={index}
            color="purple"
            variant="outline"
            className="text-xs"
          >
            {tag}
          </Badge>
        ))}
        {hasMoreTags && (
          <div
            className="cursor-pointer relative"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <Badge
              color="purple"
              variant="outline"
              className="bg-purple-100/50 dark:bg-purple-900/30 border-dashed text-xs"
            >
              +{remainingTags.length} more...
            </Badge>
            {showTooltip && (
              <div className="absolute top-full mt-2 left-1/2 transform -translate-x-1/2 bg-black dark:bg-zinc-800 text-white text-xs rounded-lg py-2 px-3 shadow-lg z-50 whitespace-nowrap max-w-xs">
                <div className="font-semibold text-purple-300 mb-1">
                  Additional Tags:
                </div>
                {remainingTags.map((tag, index) => (
                  <div key={index} className="text-gray-300">
                    • {tag}
                  </div>
                ))}
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-b-black dark:border-b-zinc-800"></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Delete confirmation modal component
interface DeleteConfirmModalProps {
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message: string;
}

const DeleteConfirmModal = ({
  onConfirm,
  onCancel,
  title,
  message,
}: DeleteConfirmModalProps) => {
  return (
    <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-md">
        <Card className="w-full">
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">
            {title}
          </h3>
          <p className="text-gray-600 dark:text-zinc-400 mb-6">{message}</p>
          <div className="flex justify-end gap-4">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 bg-pink-500 text-white rounded-md hover:bg-pink-600 transition-colors"
            >
              Delete
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
};

interface KnowledgeItemCardProps {
  item: KnowledgeItem;
  onDelete: (sourceId: string) => void;
  onUpdate?: () => void;
  onRefresh?: (sourceId: string) => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (event: React.MouseEvent) => void;
}

export const KnowledgeItemCard = ({
  item,
  onDelete,
  onUpdate,
  onRefresh,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelection
}: KnowledgeItemCardProps) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [showCodeTooltip, setShowCodeTooltip] = useState(false);
  const [showPageTooltip, setShowPageTooltip] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [loadedCodeExamples, setLoadedCodeExamples] = useState<any[] | null>(null);
  const [isLoadingCodeExamples, setIsLoadingCodeExamples] = useState(false);
  const [isRecrawling, setIsRecrawling] = useState(false);

  const statusColorMap = {
    active: 'green',
    processing: 'blue',
    error: 'pink'
  };
  
  // Updated color logic based on source type and knowledge type
  const getCardColor = () => {
    if (item.metadata.source_type === 'url') {
      // Web documents
      return item.metadata.knowledge_type === 'technical' ? 'blue' : 'cyan';
    } else {
      // Uploaded documents
      return item.metadata.knowledge_type === 'technical' ? 'purple' : 'pink';
    }
  };
  
  const accentColor = getCardColor();
  
  // Updated icon colors to match card colors
  const getSourceIconColor = () => {
    if (item.metadata.source_type === 'url') {
      return item.metadata.knowledge_type === 'technical' ? 'text-blue-500' : 'text-cyan-500';
    } else {
      return item.metadata.knowledge_type === 'technical' ? 'text-purple-500' : 'text-pink-500';
    }
  };
  
  const getTypeIconColor = () => {
    if (item.metadata.source_type === 'url') {
      return item.metadata.knowledge_type === 'technical' ? 'text-blue-500' : 'text-cyan-500';
    } else {
      return item.metadata.knowledge_type === 'technical' ? 'text-purple-500' : 'text-pink-500';
    }
  };
  
  // Get the type icon
  const TypeIcon = item.metadata.knowledge_type === 'technical' ? BoxIcon : Brain;
  const sourceIconColor = getSourceIconColor();
  const typeIconColor = getTypeIconColor();

  // Use the tilt effect hook - disable in selection mode
  const { cardRef, tiltStyles, handlers } = useCardTilt({
    max: isSelectionMode ? 0 : 10,
    scale: isSelectionMode ? 1 : 1.02,
    perspective: 1200,
  });

  const handleDelete = () => {
    setIsRemoving(true);
    // Delay the actual deletion to allow for the animation
    setTimeout(() => {
      onDelete(item.source_id);
      setShowDeleteConfirm(false);
    }, 500);
  };

  const handleRefresh = () => {
    if (onRefresh && !isRecrawling) {
      setIsRecrawling(true);
      onRefresh(item.source_id);
      // Temporary fix: Auto-reset after timeout
      // TODO: Reset based on actual crawl completion status from polling
      setTimeout(() => {
        setIsRecrawling(false);
      }, 60000); // Reset after 60 seconds as a fallback
    }
  };

  // Get code examples count from metadata
  const codeExamplesCount = item.metadata.code_examples_count || 0;

  // Load code examples when modal opens
  const handleOpenCodeModal = async () => {
    setShowCodeModal(true);
    
    // Only load if not already loaded
    if (!loadedCodeExamples && !isLoadingCodeExamples && codeExamplesCount > 0) {
      setIsLoadingCodeExamples(true);
      try {
        const response = await knowledgeBaseService.getCodeExamples(item.source_id);
        if (response.success) {
          setLoadedCodeExamples(response.code_examples);
        }
      } catch (error) {
        console.error('Failed to load code examples:', error);
      } finally {
        setIsLoadingCodeExamples(false);
      }
    }
  };

  // Format code examples for the modal (use loaded examples if available)
  const codeExamples: CodeExample[] = 
    (loadedCodeExamples || item.code_examples || []).map((example: any, index: number) => ({
      id: example.id || `${item.id}-example-${index}`,
      title: example.metadata?.example_name || example.metadata?.title || example.summary?.split('\n')[0] || 'Code Example',
      description: example.summary || 'No description available',
      language: example.metadata?.language || guessLanguageFromTitle(example.metadata?.title || ''),
      code: example.content || example.metadata?.code || '// Code example not available',
      tags: example.metadata?.tags || [],
    }));

  return (
    <div
      ref={cardRef}
      className={`card-3d relative h-full ${isRemoving ? 'card-removing' : ''}`}
      style={{
        transform: tiltStyles.transform,
        transition: tiltStyles.transition,
      }}
      {...(showCodeModal ? {} : handlers)}
    >
      <Card
        accentColor={accentColor}
        className={`relative h-full flex flex-col overflow-hidden ${
          isSelected ? 'ring-2 ring-blue-500 dark:ring-blue-400' : ''
        } ${isSelectionMode ? 'cursor-pointer' : ''}`}
        onClick={(e) => {
          if (isSelectionMode && onToggleSelection) {
            e.stopPropagation();
            onToggleSelection(e);
          }
        }}
      >
        {/* Checkbox for selection mode */}
        {isSelectionMode && (
          <div className="absolute top-3 right-3 z-20">
            <Checkbox
              checked={isSelected}
              onChange={() => {}}
              className="pointer-events-none"
            />
          </div>
        )}
        
        {/* Reflection overlay */}
        <div
          className="card-reflection"
          style={{
            opacity: tiltStyles.reflectionOpacity,
            backgroundPosition: tiltStyles.reflectionPosition,
          }}
        ></div>
        
        {/* Glow effect - updated for new colors */}
        <div
          className={`card-glow card-glow-${accentColor}`}
          style={{
            opacity: tiltStyles.glowIntensity * 0.3,
            background: `radial-gradient(circle at ${tiltStyles.glowPosition.x}% ${tiltStyles.glowPosition.y}%, 
              rgba(${accentColor === 'blue' ? '59, 130, 246' : 
                    accentColor === 'cyan' ? '34, 211, 238' : 
                    accentColor === 'purple' ? '168, 85, 247' : 
                    '236, 72, 153'}, 0.6) 0%, 
              rgba(${accentColor === 'blue' ? '59, 130, 246' : 
                    accentColor === 'cyan' ? '34, 211, 238' : 
                    accentColor === 'purple' ? '168, 85, 247' : 
                    '236, 72, 153'}, 0) 70%)`,
          }}
        ></div>
        
        {/* Content container with proper z-index and flex layout */}
        <div className="relative z-10 flex flex-col h-full">
          {/* Header section - fixed height */}
          <div className="flex items-center gap-2 mb-3 card-3d-layer-1">
            {/* Source type icon */}
            {item.metadata.source_type === 'url' ? (
              <LinkIcon 
                className={`w-4 h-4 ${sourceIconColor}`} 
                title={item.metadata.original_url || item.url || 'URL not available'}
              />
            ) : (
              <Upload className={`w-4 h-4 ${sourceIconColor}`} />
            )}
            {/* Knowledge type icon */}
            <TypeIcon className={`w-4 h-4 ${typeIconColor}`} />
            <h3 className="text-gray-800 dark:text-white font-medium flex-1 line-clamp-1 truncate min-w-0">
              {item.title}
            </h3>
            {!isSelectionMode && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowEditModal(true);
                  }}
                  className="p-1 text-gray-500 hover:text-blue-500"
                  title="Edit"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  className="p-1 text-gray-500 hover:text-red-500"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
          
          {/* Description section - fixed height */}
          <p className="text-gray-600 dark:text-zinc-400 text-sm mb-3 line-clamp-2 card-3d-layer-2">
            {item.metadata.description || 'No description available'}
          </p>
          
          {/* Tags section - flexible height with flex-1 */}
          <div className="flex-1 flex flex-col card-3d-layer-2 min-h-[4rem]">
            <TagsDisplay tags={item.metadata.tags || []} />
          </div>
          
          {/* Footer section - anchored to bottom */}
          <div className="flex items-end justify-between mt-auto card-3d-layer-1">
            {/* Left side - refresh button and updated stacked */}
            <div className="flex flex-col">
              {item.metadata.source_type === 'url' && (
                <button
                  onClick={handleRefresh}
                  disabled={isRecrawling}
                  className={`flex items-center gap-1 mb-1 px-2 py-1 transition-colors ${
                    isRecrawling 
                      ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                      : item.metadata.knowledge_type === 'technical' 
                        ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
                        : 'text-cyan-500 hover:text-cyan-600 dark:text-cyan-400 dark:hover:text-cyan-300'
                  }`}
                  title={isRecrawling ? 'Recrawl in progress...' : `Refresh from: ${item.metadata.original_url || item.url || 'URL not available'}`}
                >
                  <RefreshCw className={`w-3 h-3 ${isRecrawling ? 'animate-spin' : ''}`} />
                  <span className="text-sm font-medium">{isRecrawling ? 'Recrawling...' : 'Recrawl'}</span>
                </button>
              )}
              <span className="text-xs text-gray-500 dark:text-zinc-500">
                Updated: {new Date(item.updated_at).toLocaleDateString()}
              </span>
            </div>
            
            {/* Right side - code examples, page count and status inline */}
            <div className="flex items-center gap-2">
              {/* Code examples badge - updated colors */}
              {codeExamplesCount > 0 && (
                <div
                  className="cursor-pointer relative card-3d-layer-3"
                  onClick={handleOpenCodeModal}
                  onMouseEnter={() => setShowCodeTooltip(true)}
                  onMouseLeave={() => setShowCodeTooltip(false)}
                >
                  <div className={`flex items-center gap-1 px-2 py-1 rounded-full backdrop-blur-sm transition-all duration-300 ${
                    item.metadata.source_type === 'url'
                      ? item.metadata.knowledge_type === 'technical'
                        ? 'bg-blue-500/20 border border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.3)] hover:shadow-[0_0_20px_rgba(59,130,246,0.5)]'
                        : 'bg-cyan-500/20 border border-cyan-500/40 shadow-[0_0_15px_rgba(34,211,238,0.3)] hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]'
                      : item.metadata.knowledge_type === 'technical'
                        ? 'bg-purple-500/20 border border-purple-500/40 shadow-[0_0_15px_rgba(168,85,247,0.3)] hover:shadow-[0_0_20px_rgba(168,85,247,0.5)]'
                        : 'bg-pink-500/20 border border-pink-500/40 shadow-[0_0_15px_rgba(236,72,153,0.3)] hover:shadow-[0_0_20px_rgba(236,72,153,0.5)]'
                  }`}>
                    <Code className={`w-3 h-3 ${
                      item.metadata.source_type === 'url'
                        ? item.metadata.knowledge_type === 'technical' ? 'text-blue-400' : 'text-cyan-400'
                        : item.metadata.knowledge_type === 'technical' ? 'text-purple-400' : 'text-pink-400'
                    }`} />
                    <span className={`text-xs font-medium ${
                      item.metadata.source_type === 'url'
                        ? item.metadata.knowledge_type === 'technical' ? 'text-blue-400' : 'text-cyan-400'
                        : item.metadata.knowledge_type === 'technical' ? 'text-purple-400' : 'text-pink-400'
                    }`}>
                      {codeExamplesCount}
                    </span>
                  </div>
                  {/* Code Examples Tooltip - positioned relative to the badge */}
                  {showCodeTooltip && (
                    <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 bg-black dark:bg-zinc-800 text-white text-xs rounded-lg py-2 px-3 shadow-lg z-50 max-w-xs">
                      <div className={`font-semibold mb-2 ${
                        item.metadata.source_type === 'url'
                          ? item.metadata.knowledge_type === 'technical' ? 'text-blue-300' : 'text-cyan-300'
                          : item.metadata.knowledge_type === 'technical' ? 'text-purple-300' : 'text-pink-300'
                      }`}>
                        Click for Code Browser
                      </div>
                      <div className="max-h-32 overflow-y-auto">
                        {codeExamples.map((example, index) => (
                          <div key={index} className={`mb-1 last:mb-0 ${
                            item.metadata.source_type === 'url'
                              ? item.metadata.knowledge_type === 'technical' ? 'text-blue-200' : 'text-cyan-200'
                              : item.metadata.knowledge_type === 'technical' ? 'text-purple-200' : 'text-pink-200'
                          }`}>
                            • {example.title}
                          </div>
                        ))}
                      </div>
                      <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-black dark:border-t-zinc-800"></div>
                    </div>
                  )}
                </div>
              )}
              
              {/* Page count - orange neon container */}
              <div
                className="relative card-3d-layer-3"
                onMouseEnter={() => setShowPageTooltip(true)}
                onMouseLeave={() => setShowPageTooltip(false)}
              >
                <div className="flex items-center gap-1 px-2 py-1 bg-orange-500/20 border border-orange-500/40 rounded-full backdrop-blur-sm shadow-[0_0_15px_rgba(251,146,60,0.3)] transition-all duration-300">
                  <FileText className="w-3 h-3 text-orange-400" />
                  <span className="text-xs text-orange-400 font-medium">
                    {Math.ceil(
                      (item.metadata.word_count || 0) / 250,
                    ).toLocaleString()}
                  </span>
                </div>
                {/* Page count tooltip - positioned relative to the badge */}
                {showPageTooltip && (
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 bg-black dark:bg-zinc-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg z-50 whitespace-nowrap">
                    <div className="font-medium mb-1">
                      {(item.metadata.word_count || 0).toLocaleString()} words
                    </div>
                    <div className="text-gray-300 space-y-0.5">
                      <div>
                        = {Math.ceil((item.metadata.word_count || 0) / 250).toLocaleString()} pages
                      </div>
                      <div>
                        = {((item.metadata.word_count || 0) / 80000).toFixed(1)} average novels
                      </div>
                    </div>
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-black dark:border-t-zinc-800"></div>
                  </div>
                )}
              </div>
              
              <Badge
                color={statusColorMap[item.metadata.status || 'active'] as any}
                className="card-3d-layer-2"
              >
                {(item.metadata.status || 'active').charAt(0).toUpperCase() +
                  (item.metadata.status || 'active').slice(1)}
              </Badge>
            </div>
          </div>
        </div>
      </Card>
      
      {/* Code Examples Modal */}
      {showCodeModal && (
        <CodeViewerModal
          examples={codeExamples}
          onClose={() => setShowCodeModal(false)}
          isLoading={isLoadingCodeExamples}
        />
      )}
      
      {showDeleteConfirm && (
        <DeleteConfirmModal
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          title="Delete Knowledge Item"
          message="Are you sure you want to delete this knowledge item? This action cannot be undone."
        />
      )}
      
      {/* Edit Modal */}
      {showEditModal && (
        <EditKnowledgeItemModal
          item={item}
          onClose={() => setShowEditModal(false)}
          onUpdate={() => {
            if (onUpdate) onUpdate();
          }}
        />
      )}
    </div>
  );
}; 