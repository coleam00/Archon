import { useState } from 'react';
import { Search, Sparkles, FileText, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { useToast } from '../../contexts/ToastContext';
import { performRAGQuery } from '../../services/api';

interface RAGResult {
  content: string;
  similarity: number;
  source_id: string;
  url?: string;
  title?: string;
  chunk_number?: number;
}

interface RAGQueryResponse {
  success: boolean;
  results: RAGResult[];
  execution_path?: string;
  search_mode?: string;
  error?: string;
}

export const RAGQuerySection = () => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RAGResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [executionInfo, setExecutionInfo] = useState<{ path?: string; mode?: string }>({});
  const { showToast } = useToast();

  const handleSearch = async () => {
    if (!query.trim()) {
      showToast('Please enter a search query', 'warning');
      return;
    }

    setLoading(true);
    setShowResults(true);
    
    try {
      const response = await performRAGQuery(query, {
        match_count: 5,
        use_hybrid_search: true,
      }) as RAGQueryResponse;

      if (response.success && response.results) {
        setResults(response.results);
        setExecutionInfo({
          path: response.execution_path,
          mode: response.search_mode,
        });
        
        if (response.results.length === 0) {
          showToast('No results found for your query', 'info');
        }
      } else {
        setResults([]);
        showToast(response.error || 'Failed to perform RAG query', 'error');
      }
    } catch (error) {
      console.error('RAG query error:', error);
      setResults([]);
      showToast('Failed to perform search', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  const clearResults = () => {
    setShowResults(false);
    setResults([]);
    setQuery('');
    setExecutionInfo({});
  };

  return (
    <div className="mb-8">
      {/* Search Bar */}
      <Card className="p-6 bg-gradient-to-r from-purple-500/5 to-blue-500/5 border-purple-500/20">
        <div className="flex items-center gap-3 mb-4">
          <Sparkles className="w-5 h-5 text-purple-500" />
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
            RAG Knowledge Search
          </h3>
        </div>
        
        <div className="flex gap-3">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask a question about your knowledge base..."
            accentColor="purple"
            icon={<Search className="w-4 h-4" />}
            disabled={loading}
          />
          <Button
            onClick={handleSearch}
            variant="primary"
            accentColor="purple"
            disabled={loading || !query.trim()}
            className="shadow-lg shadow-purple-500/20"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Search
              </>
            )}
          </Button>
        </div>

        {/* Execution Info */}
        {executionInfo.mode && (
          <div className="mt-3 flex items-center gap-2">
            <Badge color="purple" variant="outline" size="sm">
              {executionInfo.mode}
            </Badge>
            {executionInfo.path && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                via {executionInfo.path}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Results */}
      <AnimatePresence>
        {showResults && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="mt-4"
          >
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-md font-semibold text-gray-700 dark:text-gray-300">
                  Search Results ({results.length})
                </h4>
                <Button
                  onClick={clearResults}
                  variant="ghost"
                  size="sm"
                  accentColor="gray"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="animate-pulse">
                      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-full" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-5/6 mt-1" />
                    </div>
                  ))}
                </div>
              ) : results.length > 0 ? (
                <div className="space-y-4">
                  {results.map((result, index) => (
                    <motion.div
                      key={`${result.source_id}-${index}`}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-blue-500" />
                          <span className="font-medium text-sm text-gray-800 dark:text-gray-200">
                            {result.title || 'Document'}
                          </span>
                          {result.chunk_number && (
                            <Badge color="gray" variant="outline" size="sm">
                              Chunk #{result.chunk_number}
                            </Badge>
                          )}
                        </div>
                        <Badge 
                          color={result.similarity > 0.8 ? "green" : result.similarity > 0.6 ? "yellow" : "gray"}
                          variant="solid"
                          size="sm"
                        >
                          {(result.similarity * 100).toFixed(1)}% match
                        </Badge>
                      </div>
                      
                      <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
                        {result.content}
                      </p>
                      
                      {result.url && (
                        <a
                          href={result.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 mt-2 inline-block"
                        >
                          View source →
                        </a>
                      )}
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No results found for your query.</p>
                  <p className="text-sm mt-1">Try rephrasing your question or using different keywords.</p>
                </div>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};