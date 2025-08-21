import React, { useState, useEffect } from 'react';
import { X, Clock, RotateCcw, Eye, Calendar, User, FileText, Diff, GitBranch, Layers, Plus, Minus, AlertTriangle } from 'lucide-react';
import { projectService } from '../../services/projectService';
import { Button } from '../ui/Button';
import { useToast } from '../../contexts/ToastContext';

interface Version {
  id: string;
  version_number: number;
  change_summary: string;
  change_type: string;
  created_by: string;
  created_at: string;
  content: any;
  document_id?: string;
}

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  documentId?: string;
  fieldName?: string;
  onRestore?: () => void;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNumber?: number;
}

interface RestoreConfirmModalProps {
  isOpen: boolean;
  versionNumber: number;
  onConfirm: () => void;
  onCancel: () => void;
}

const RestoreConfirmModal: React.FC<RestoreConfirmModalProps> = ({
  isOpen,
  versionNumber,
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-orange-500 
          before:shadow-[0_0_10px_2px_rgba(249,115,22,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(249,115,22,0.7)]">
        
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-orange-600 dark:text-orange-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                Restore Version
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will create a new version
              </p>
            </div>
          </div>
          
          <p className="text-gray-700 dark:text-gray-300 mb-6">
            Are you sure you want to restore to <span className="font-medium text-orange-600 dark:text-orange-400">version {versionNumber}</span>? 
            This will create a new version with the restored content.
          </p>
          
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button 
              variant="primary" 
              accentColor="orange" 
              onClick={onConfirm}
              icon={<RotateCcw className="w-4 h-4" />}
            >
              Restore Version
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  isOpen,
  onClose,
  projectId,
  documentId,
  fieldName = 'docs',
  onRestore
}) => {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<any>(null);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [currentContent, setCurrentContent] = useState<any>(null);
  const [viewMode, setViewMode] = useState<'diff' | 'rendered'>('diff');
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [versionToRestore, setVersionToRestore] = useState<number | null>(null);

  const { showToast } = useToast();

  useEffect(() => {
    if (isOpen && projectId) {
      loadVersionHistory();
      loadCurrentContent();
    }
  }, [isOpen, projectId, fieldName, documentId]);

  const loadVersionHistory = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const versionData = await projectService.getDocumentVersionHistory(projectId, fieldName);
      
      // Filter versions by document if documentId is provided
      let filteredVersions = versionData || [];
      if (documentId) {
        filteredVersions = versionData.filter((version: Version) => {
          // Check if this version contains changes to the specific document
          if (version.document_id === documentId) {
            return true;
          }
          // Also check if the content contains the document
          if (Array.isArray(version.content)) {
            return version.content.some((doc: any) => doc.id === documentId);
          }
          return false;
        });
      }
      
      setVersions(filteredVersions);
    } catch (error) {
      console.error('Error loading version history:', error);
      setError('Failed to load version history');
      showToast('Failed to load version history', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadCurrentContent = async () => {
    try {
      const currentProject = await projectService.getProject(projectId);
      setCurrentContent((currentProject as any)[fieldName] || []);
    } catch (error) {
      console.error('Error loading current content:', error);
      showToast('Failed to load current content', 'error');
    }
  };

  const handlePreview = async (versionNumber: number) => {
    try {
      setPreviewVersion(versionNumber);
      const contentData = await projectService.getVersionContent(projectId, versionNumber, fieldName);
      setPreviewContent(contentData.content);
    } catch (error) {
      console.error('Error loading version content:', error);
      setError('Failed to load version content');
      showToast('Failed to load version content', 'error');
    }
  };

  const handleRestoreClick = (versionNumber: number) => {
    setVersionToRestore(versionNumber);
    setShowRestoreConfirm(true);
  };

  const handleRestoreConfirm = async () => {
    if (!versionToRestore) return;

    setRestoring(versionToRestore);
    setError(null);
    setShowRestoreConfirm(false);

    try {
      await projectService.restoreDocumentVersion(projectId, versionToRestore, fieldName);
      await loadVersionHistory();
      await loadCurrentContent();
      
      if (onRestore) {
        onRestore();
      }
      
      showToast(`Successfully restored to version ${versionToRestore}`, 'success');
    } catch (error) {
      console.error('Error restoring version:', error);
      setError('Failed to restore version');
      showToast('Failed to restore version', 'error');
    } finally {
      setRestoring(null);
      setVersionToRestore(null);
    }
  };

  const handleRestoreCancel = () => {
    setShowRestoreConfirm(false);
    setVersionToRestore(null);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getChangeTypeIcon = (changeType: string) => {
    switch (changeType) {
      case 'create':
        return <FileText className="w-4 h-4 text-emerald-400" />;
      case 'update':
        return <Clock className="w-4 h-4 text-blue-400" />;
      case 'delete':
        return <X className="w-4 h-4 text-red-400" />;
      case 'restore':
        return <RotateCcw className="w-4 h-4 text-purple-400" />;
      default:
        return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  const extractTextContent = (content: any, docId?: string): string => {
    if (!content) return '';
    
    // If content is an array of documents
    if (Array.isArray(content)) {
      // If we have a documentId, filter to just that document
      if (docId) {
        const doc = content.find(d => d.id === docId);
        if (doc) {
          // If it has markdown content, return that
          if (doc.content?.markdown) {
            return doc.content.markdown;
          }
          // Otherwise try to extract text content
          return extractDocumentText(doc);
        }
        return 'Document not found in this version';
      }
      // Otherwise show all documents
      return content.map(doc => {
        if (doc.content?.markdown) {
          return `=== ${doc.title || 'Document'} ===\n${doc.content.markdown}`;
        }
        return `=== ${doc.title || 'Document'} ===\n${extractDocumentText(doc)}`;
      }).join('\n\n');
    }
    
    // If content is an object with markdown
    if (typeof content === 'object' && content.markdown) {
      return content.markdown;
    }
    
    if (typeof content === 'object') {
      return JSON.stringify(content, null, 2);
    }
    
    return String(content);
  };

  const extractDocumentText = (doc: any): string => {
    let text = '';
    if (doc.blocks) {
      text = doc.blocks.map((block: any) => {
        if (block.content) {
          return block.content;
        }
        return '';
      }).filter(Boolean).join('\n');
    } else if (doc.content && typeof doc.content === 'string') {
      text = doc.content;
    } else if (doc.content && typeof doc.content === 'object') {
      text = JSON.stringify(doc.content, null, 2);
    }
    return text;
  };

  const generateDiff = (oldContent: any, newContent: any): DiffLine[] => {
    const oldText = extractTextContent(oldContent, documentId);
    const newText = extractTextContent(newContent, documentId);
    
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    
    const diff: DiffLine[] = [];
    
    // Simple line-by-line diff (in a real app you'd use a proper diff library)
    const maxLines = Math.max(oldLines.length, newLines.length);
    
    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';
      
      if (oldLine === newLine) {
        if (oldLine) {
          diff.push({ type: 'unchanged', content: oldLine, lineNumber: i + 1 });
        }
      } else {
        if (oldLine && !newLines.includes(oldLine)) {
          diff.push({ type: 'removed', content: oldLine, lineNumber: i + 1 });
        }
        if (newLine && !oldLines.includes(newLine)) {
          diff.push({ type: 'added', content: newLine, lineNumber: i + 1 });
        }
      }
    }
    
    return diff;
  };

  const renderInlineDiff = () => {
    if (!previewContent || !currentContent) {
      return (
        <div className="text-center py-12">
          <Diff className="w-16 h-16 text-gray-600 mx-auto mb-4 opacity-50" />
          <p className="text-gray-500 text-lg">Select a version to see changes</p>
        </div>
      );
    }

    const diffLines = generateDiff(previewContent, currentContent);
    
    // If filtering by document but no changes found
    if (documentId && diffLines.length === 0) {
      return (
        <div className="text-center py-12">
          <FileText className="w-16 h-16 text-gray-600 mx-auto mb-4 opacity-50" />
          <p className="text-gray-500 text-lg">No changes found for this document in the selected version</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
          <Diff className="w-4 h-4" />
          Comparing Version {previewVersion} → Current
        </div>
        
        <div className="bg-gray-900/50 rounded-lg border border-gray-700/50 overflow-hidden">
          <div className="bg-gray-800/50 px-4 py-2 border-b border-gray-700/50">
            <span className="text-gray-300 text-sm font-mono">Changes</span>
          </div>
          
          <div className="max-h-96 overflow-y-auto font-mono text-sm">
            {diffLines.map((line, index) => (
              <div
                key={index}
                className={`flex items-start px-4 py-1 ${
                  line.type === 'added' 
                    ? 'bg-green-500/10 border-l-2 border-green-500' 
                    : line.type === 'removed'
                    ? 'bg-red-500/10 border-l-2 border-red-500'
                    : 'hover:bg-gray-800/30'
                }`}
              >
                <span className="text-gray-500 w-8 text-right mr-4 select-none">
                  {line.lineNumber}
                </span>
                <span className="mr-3 w-4 flex-shrink-0">
                  {line.type === 'added' && <Plus className="w-3 h-3 text-green-400" />}
                  {line.type === 'removed' && <Minus className="w-3 h-3 text-red-400" />}
                </span>
                <span className={`flex-1 ${
                  line.type === 'added' 
                    ? 'text-green-300' 
                    : line.type === 'removed'
                    ? 'text-red-300'
                    : 'text-gray-300'
                }`}>
                  {line.content || ' '}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderDocumentContent = (content: any) => {
    if (!content) return <div className="text-gray-500 text-center py-8">No content available</div>;

    // Extract the markdown content for the specific document
    const markdownContent = extractTextContent(content, documentId);
    
    if (markdownContent === 'Document not found in this version') {
      return (
        <div className="text-center py-12">
          <FileText className="w-16 h-16 text-gray-600 mx-auto mb-4 opacity-50" />
          <p className="text-gray-500 text-lg">Document not found in this version</p>
        </div>
      );
    }
    
    // Render the markdown content
    return (
      <div className="prose prose-invert max-w-none">
        <pre className="whitespace-pre-wrap bg-gray-900/50 p-6 rounded-lg border border-gray-700/50 text-gray-300 font-mono text-sm overflow-auto">
          {markdownContent}
        </pre>
      </div>
    );
    
    // Old array handling code - keeping for reference but not using
    if (Array.isArray(content) && false) {
      return (
        <div className="space-y-6">
          {content.map((doc, index) => (
            <div key={index} className="border border-gray-700/50 rounded-lg p-4 bg-gray-900/30">
              <div className="flex items-center gap-3 mb-4">
                <FileText className="w-5 h-5 text-blue-400" />
                <h3 className="text-lg font-semibold text-white">{doc.title || `Document ${index + 1}`}</h3>
              </div>
              {doc.blocks && (
                <div className="prose prose-invert max-w-none">
                  {doc.blocks.map((block: any, blockIndex: number) => (
                    <div key={blockIndex} className="mb-4">
                      {block.type === 'heading_1' && (
                        <h1 className="text-2xl font-bold text-white mb-2">{block.content}</h1>
                      )}
                      {block.type === 'heading_2' && (
                        <h2 className="text-xl font-semibold text-white mb-2">{block.content}</h2>
                      )}
                      {block.type === 'heading_3' && (
                        <h3 className="text-lg font-medium text-white mb-2">{block.content}</h3>
                      )}
                      {block.type === 'paragraph' && (
                        <p className="text-gray-300 leading-relaxed mb-2">{block.content}</p>
                      )}
                      {block.type === 'bulletListItem' && (
                        <ul className="list-disc list-inside text-gray-300 mb-2">
                          <li>{block.content}</li>
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }

    if (typeof content === 'object') {
      return (
        <div className="border border-gray-700/50 rounded-lg p-4 bg-gray-900/30">
          <pre className="text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(content, null, 2)}
          </pre>
        </div>
      );
    }

    return <div className="text-gray-500">Unsupported content type</div>;
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
        <div className="relative w-full max-w-6xl h-5/6 flex flex-col bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border border-purple-500/30 rounded-lg overflow-hidden shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)] backdrop-blur-md">
          {/* Neon top edge */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-purple-500 shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]"></div>
          
          {/* Header */}
          <div className="relative z-10 flex items-center justify-between p-6 border-b border-purple-500/30">
            <h2 className="text-xl font-semibold text-white flex items-center gap-3">
              <Clock className="w-6 h-6 text-purple-400" />
              Version History
              <span className="text-purple-400">- {fieldName}{documentId ? ' (Document Filtered)' : ''}</span>
            </h2>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-white/10 transition-all duration-300"
            >
              <X className="w-6 h-6 text-gray-400 hover:text-red-400" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 flex overflow-hidden relative z-10">
            {/* Version List */}
            <div className="w-1/3 border-r border-purple-500/30 overflow-y-auto">
              <div className="p-6">
                <h3 className="font-medium text-white mb-4 flex items-center gap-2">
                  <GitBranch className="w-5 h-5 text-purple-400" />
                  Versions
                </h3>
                
                {loading && (
                  <div className="text-center py-8">
                    <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-400">Loading versions...</p>
                  </div>
                )}

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
                    <p className="text-red-400 text-sm">{error}</p>
                  </div>
                )}

                {!loading && versions.length === 0 && (
                  <div className="text-center py-8">
                    <Clock className="w-12 h-12 text-gray-600 mx-auto mb-4 opacity-50" />
                    <p className="text-gray-500">No versions found</p>
                  </div>
                )}

                <div className="space-y-3">
                  {versions.map((version) => (
                    <div
                      key={version.id}
                      className={`relative p-4 rounded-lg cursor-pointer transition-all duration-300 border ${
                        previewVersion === version.version_number
                          ? 'bg-blue-500/20 border-blue-500/50'
                          : 'bg-white/5 border-gray-500/30 hover:bg-white/10 hover:border-gray-400/50'
                      }`}
                      onClick={() => handlePreview(version.version_number)}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          {getChangeTypeIcon(version.change_type)}
                          <span className="font-medium text-white">
                            Version {version.version_number}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            accentColor="green"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestoreClick(version.version_number);
                            }}
                            disabled={restoring === version.version_number}
                            icon={restoring === version.version_number ? 
                              <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" /> :
                              <RotateCcw className="w-4 h-4" />
                            }
                          >
                            Restore
                          </Button>
                        </div>
                      </div>
                      
                      <p className="text-sm text-gray-300 mb-3">
                        {version.change_summary}
                        {version.document_id && documentId && version.document_id === documentId && (
                          <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                            This document
                          </span>
                        )}
                      </p>
                      
                      <div className="flex items-center gap-4 text-xs text-gray-400">
                        <div className="flex items-center gap-1.5">
                          <User className="w-3 h-3" />
                          {version.created_by}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3 h-3" />
                          {formatDate(version.created_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Preview Panel */}
            <div className="flex-1 overflow-y-auto">
              <div className="p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-medium text-white flex items-center gap-3">
                    <Eye className="w-5 h-5 text-blue-400" />
                    {viewMode === 'diff' ? 'Changes' : 'Content'}
                  </h3>
                  
                  {previewVersion !== null && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant={viewMode === 'diff' ? 'primary' : 'ghost'}
                        size="sm"
                        accentColor="purple"
                        onClick={() => setViewMode('diff')}
                        icon={<Diff className="w-4 h-4" />}
                      >
                        Diff View
                      </Button>
                      <Button
                        variant={viewMode === 'rendered' ? 'primary' : 'ghost'}
                        size="sm"
                        accentColor="blue"
                        onClick={() => setViewMode('rendered')}
                        icon={<Layers className="w-4 h-4" />}
                      >
                        Rendered
                      </Button>
                    </div>
                  )}
                </div>
                
                {previewVersion === null ? (
                  <div className="text-center py-12">
                    <Eye className="w-16 h-16 text-gray-600 mx-auto mb-6 opacity-50" />
                    <p className="text-gray-500 text-lg">Select a version to preview</p>
                  </div>
                ) : (
                  <div>
                    {viewMode === 'diff' ? renderInlineDiff() : renderDocumentContent(previewContent)}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="relative z-10 border-t border-purple-500/30 p-6">
            <div className="flex justify-end">
              <Button
                variant="ghost"
                accentColor="purple"
                onClick={onClose}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Restore Confirmation Modal */}
      <RestoreConfirmModal
        isOpen={showRestoreConfirm}
        versionNumber={versionToRestore || 0}
        onConfirm={handleRestoreConfirm}
        onCancel={handleRestoreCancel}
      />
    </>
  );
}; 