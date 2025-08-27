import React, { useState } from 'react';
import { Rocket, Code, Briefcase, Users, FileText, X, Plus, Clipboard } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';

export interface ProjectDoc {
  id: string;
  title: string;
  content: any;
  document_type?: string;
  updated_at: string;
  created_at?: string;
}

interface DocumentCardProps {
  document: ProjectDoc;
  isActive: boolean;
  onSelect: (doc: ProjectDoc) => void;
  onDelete: (docId: string) => void;
  isDarkMode: boolean;
}

export const DocumentCard: React.FC<DocumentCardProps> = ({
  document,
  isActive,
  onSelect,
  onDelete,
  isDarkMode
}) => {
  const [showDelete, setShowDelete] = useState(false);
  const { showToast } = useToast();
  
  const getDocumentIcon = (type?: string) => {
    switch (type) {
      case 'prp': return <Rocket className="w-4 h-4" />;
      case 'technical': return <Code className="w-4 h-4" />;
      case 'business': return <Briefcase className="w-4 h-4" />;
      case 'meeting_notes': return <Users className="w-4 h-4" />;
      default: return <FileText className="w-4 h-4" />;
    }
  };
  
  const getTypeColor = (type?: string) => {
    switch (type) {
      case 'prp': return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30';
      case 'technical': return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30';
      case 'business': return 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30';
      case 'meeting_notes': return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30';
      default: return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30';
    }
  };

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(document.id);
    showToast('Document ID copied to clipboard', 'success');
    
    // Visual feedback
    const button = e.currentTarget;
    const originalHTML = button.innerHTML;
    button.innerHTML = '<div class="flex items-center gap-1"><span class="w-3 h-3 text-green-500">✓</span><span class="text-green-500 text-xs">Copied</span></div>';
    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 2000);
  };
  
  return (
    <div
      className={`
        relative flex-shrink-0 w-48 p-4 rounded-lg cursor-pointer
        transition-all duration-200 group
        ${isActive 
          ? 'bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-500 shadow-lg scale-105' 
          : 'bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md'
        }
      `}
      onClick={() => onSelect(document)}
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      {/* Document Type Badge */}
      <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium mb-2 border ${getTypeColor(document.document_type)}`}>
        {getDocumentIcon(document.document_type)}
        <span>{document.document_type || 'document'}</span>
      </div>
      
      {/* Title */}
      <h4 className="font-medium text-gray-900 dark:text-white text-sm line-clamp-2 mb-1">
        {document.title}
      </h4>
      
      {/* Metadata */}
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        {new Date(document.updated_at || document.created_at || Date.now()).toLocaleDateString()}
      </p>

      {/* ID Display Section - Always visible for active, hover for others */}
      <div className={`flex items-center justify-between mt-2 ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-200`}>
        <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[120px]" title={document.id}>
          {document.id.slice(0, 8)}...
        </span>
        <button 
          type="button"
          onClick={handleCopyId}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Copy Document ID to clipboard"
          aria-label="Copy Document ID to clipboard"
        >
          <Clipboard className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>
      
      {/* Delete Button */}
      {showDelete && !isActive && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${document.title}"?`)) {
              onDelete(document.id);
            }
          }}
          className="absolute top-2 right-2 p-1 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 transition-colors"
          aria-label={`Delete ${document.title}`}
          title="Delete document"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

// New Document Card Component
interface NewDocumentCardProps {
  onClick: () => void;
}

export const NewDocumentCard: React.FC<NewDocumentCardProps> = ({ onClick }) => {
  return (
    <div
      onClick={onClick}
      className="flex-shrink-0 w-48 h-[120px] rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 flex flex-col items-center justify-center cursor-pointer transition-colors group"
    >
      <Plus className="w-8 h-8 text-gray-400 group-hover:text-blue-500 transition-colors mb-2" />
      <span className="text-sm text-gray-500 group-hover:text-blue-500">New Document</span>
    </div>
  );
};