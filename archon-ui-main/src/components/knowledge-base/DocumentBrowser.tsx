import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search, Filter, FileText, Globe, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { knowledgeBaseService } from '../../services/knowledgeBaseService';

interface DocumentChunk {
  id: string;
  source_id: string;
  content: string;
  metadata?: any;
  url?: string;
}

interface DocumentBrowserProps {
  sourceId: string;
  isOpen: boolean;
  onClose: () => void;
}

const extractDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Remove 'www.' prefix if present
    const withoutWww = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
    
    // Keep full hostname (minus 'www.') to preserve subdomain-level filtering
    return withoutWww;
  } catch {
    return url; // Return original if URL parsing fails
  }
};

export const DocumentBrowser: React.FC<DocumentBrowserProps> = ({
  sourceId,
  isOpen,
  onClose,
}) => {
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<string>('all');
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Extract unique domains from chunks
  const domains = useMemo(() => {
    const domainSet = new Set<string>();
    chunks.forEach(chunk => {
      if (chunk.url) {
        domainSet.add(extractDomain(chunk.url));
      }
    });
    return Array.from(domainSet).sort();
  }, [chunks]);

  // Filter chunks based on search and domain
  const filteredChunks = useMemo(() => {
    return chunks.filter(chunk => {
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      const searchMatch = !searchQuery || 
        chunk.content.toLowerCase().includes(searchLower) ||
        chunk.url?.toLowerCase().includes(searchLower);
      
      // Domain filter
      const domainMatch = selectedDomain === 'all' || 
        (chunk.url && extractDomain(chunk.url) === selectedDomain);
      
      return searchMatch && domainMatch;
    });
  }, [chunks, searchQuery, selectedDomain]);

  // Get selected chunk
  const selectedChunk = useMemo(() => {
    return filteredChunks.find(chunk => chunk.id === selectedChunkId) || filteredChunks[0];
  }, [filteredChunks, selectedChunkId]);

  // Load chunks when component opens
  useEffect(() => {
    if (isOpen && sourceId) {
      loadChunks();
    }
  }, [isOpen, sourceId]);

  const loadChunks = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await knowledgeBaseService.getKnowledgeItemChunks(sourceId);
      
      if (response.success) {
        setChunks(response.chunks);
        // Auto-select first chunk if none selected
        if (response.chunks.length > 0 && !selectedChunkId) {
          setSelectedChunkId(response.chunks[0].id);
        }
      } else {
        setError('Failed to load document chunks');
      }
    } catch (error) {
      console.error('Failed to load chunks:', error);
      setError(error instanceof Error ? error.message : 'Failed to load document chunks');
    } finally {
      setLoading(false);
    }
  };

  const loadChunksWithDomainFilter = async (domain: string) => {
    try {
      setLoading(true);
      setError(null);
      
      const domainFilter = domain === 'all' ? undefined : domain;
      const response = await knowledgeBaseService.getKnowledgeItemChunks(sourceId, domainFilter);
      
      if (response.success) {
        setChunks(response.chunks);
      } else {
        setError('Failed to load document chunks');
      }
    } catch (error) {
      console.error('Failed to load chunks with domain filter:', error);
      setError(error instanceof Error ? error.message : 'Failed to load document chunks');
    } finally {
      setLoading(false);
    }
  };

  const handleDomainChange = (domain: string) => {
    setSelectedDomain(domain);
    // Note: We could reload with server-side filtering, but for now we'll do client-side filtering
    // loadChunksWithDomainFilter(domain);
  };

  if (!isOpen) return null;

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
        className="relative bg-gray-900/95 border border-gray-800 rounded-xl w-full max-w-7xl h-[85vh] flex overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Blue accent line at the top */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-blue-500 to-cyan-500 shadow-[0_0_20px_5px_rgba(59,130,246,0.5)]"></div>

        {/* Sidebar */}
        <div className="w-80 bg-gray-950/50 border-r border-gray-800 flex flex-col overflow-hidden">
          {/* Sidebar Header */}
          <div className="p-4 border-b border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-blue-400">
                Document Chunks ({(filteredChunks || []).length})
              </h3>
            </div>
            
            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder="Search documents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 bg-gray-900/70 border border-gray-800 rounded-lg text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
              />
            </div>

            {/* Domain Filter */}
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-gray-500" />
              <select
                value={selectedDomain}
                onChange={(e) => handleDomainChange(e.target.value)}
                className="flex-1 bg-gray-900/70 border border-gray-800 rounded-lg text-sm text-gray-300 px-3 py-2 focus:outline-none focus:border-blue-500/50"
              >
                <option value="all">All Domains</option>
                {domains?.map(domain => (
                  <option key={domain} value={domain}>{domain}</option>
                )) || []}
              </select>
            </div>
          </div>

          {/* Document List */}
          <div className="flex-1 overflow-y-auto p-2">
            {filteredChunks.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-8">
                No documents found
              </div>
            ) : (
              filteredChunks.map((chunk, index) => (
                <button
                  key={chunk.id}
                  onClick={() => setSelectedChunkId(chunk.id)}
                  className={`w-full text-left p-3 mb-1 rounded-lg transition-all duration-200 ${
                    selectedChunk?.id === chunk.id
                      ? 'bg-blue-500/20 border border-blue-500/40 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                      : 'hover:bg-gray-800/50 border border-transparent'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <FileText className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      selectedChunk?.id === chunk.id ? 'text-blue-400' : 'text-gray-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${
                        selectedChunk?.id === chunk.id ? 'text-blue-300' : 'text-gray-300'
                      } line-clamp-1`}>
                        Chunk {index + 1}
                      </div>
                      <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">
                        {chunk.content?.substring(0, 100) || 'No content'}...
                      </div>
                      {chunk.url && (
                        <div className="text-xs text-blue-400 mt-1 truncate">
                          {extractDomain(chunk.url)}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="p-4 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-blue-400">
                {selectedChunk ? `Document Chunk` : 'Document Browser'}
              </h2>
              {selectedChunk?.url && (
                <Badge color="blue" className="flex items-center gap-1">
                  <Globe className="w-3 h-3" />
                  {extractDomain(selectedChunk.url)}
                </Badge>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-white p-1 rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          {/* Content */}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto mb-4"></div>
                  <p className="text-gray-400">Loading document chunks...</p>
                </div>
              </div>
            ) : !selectedChunk || filteredChunks.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <FileText className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-400">Select a document chunk to view content</p>
                </div>
              </div>
            ) : (
              <div className="h-full p-4">
                <div className="bg-gray-900/70 rounded-lg border border-gray-800 h-full overflow-auto">
                  <div className="p-6">
                    {selectedChunk.url && (
                      <div className="text-sm text-blue-400 mb-4 font-mono">
                        {selectedChunk.url}
                      </div>
                    )}
                    
                    <div className="prose prose-sm prose-invert max-w-none">
                      <div className="text-gray-300 whitespace-pre-wrap leading-relaxed">
                        {selectedChunk.content || 'No content available'}
                      </div>
                    </div>
                    
                    {selectedChunk.metadata && (
                      <div className="mt-6 pt-4 border-t border-gray-700">
                        <details className="text-sm text-gray-400">
                          <summary className="cursor-pointer hover:text-gray-300 font-medium">
                            View Metadata
                          </summary>
                          <pre className="mt-3 bg-gray-800 p-3 rounded text-xs overflow-x-auto text-gray-300">
                            {JSON.stringify(selectedChunk.metadata, null, 2)}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
};