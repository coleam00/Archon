import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CrawlingProgressCard } from './CrawlingProgressCard';
import { CrawlProgressData } from '../../types/crawl';
import { AlertCircle } from 'lucide-react';

interface CrawlingTabProps {
  progressItems: CrawlProgressData[];
  onProgressComplete: (data: CrawlProgressData) => void;
  onProgressError: (error: string, progressId?: string) => void;
  onRetryProgress: (progressId: string) => void;
  onStopProgress: (progressId: string) => void;
  onDismissProgress: (progressId: string) => void;
}

export const CrawlingTab = ({
  progressItems,
  onProgressComplete,
  onProgressError,
  onRetryProgress,
  onStopProgress,
  onDismissProgress
}: CrawlingTabProps) => {
  // Group progress items by type for better organization
  const groupedItems = progressItems.reduce((acc, item) => {
    const type = item.crawlType || (item.uploadType === 'document' ? 'upload' : 'normal');
    if (!acc[type]) acc[type] = [];
    acc[type].push(item);
    return acc;
  }, {} as Record<string, CrawlProgressData[]>);

  const getSectionTitle = (type: string) => {
    switch (type) {
      case 'sitemap': return 'Sitemap Crawls';
      case 'llms-txt': return 'LLMs.txt Crawls';
      case 'upload': return 'Document Uploads';
      case 'refresh': return 'Refreshing Sources';
      default: return 'Web Crawls';
    }
  };

  const getSectionDescription = (type: string) => {
    switch (type) {
      case 'sitemap': 
        return 'Processing sitemap.xml files to discover and crawl all listed pages';
      case 'llms-txt': 
        return 'Extracting content from llms.txt files for AI model training';
      case 'upload': 
        return 'Processing uploaded documents and extracting content';
      case 'refresh': 
        return 'Re-crawling existing sources to update content';
      default: 
        return 'Recursively crawling websites to extract knowledge';
    }
  };

  if (progressItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="w-12 h-12 text-gray-400 dark:text-zinc-600 mb-4" />
        <h3 className="text-lg font-medium text-gray-700 dark:text-zinc-300 mb-2">
          No Active Crawls
        </h3>
        <p className="text-gray-500 dark:text-zinc-500 max-w-md">
          Start crawling a website or uploading a document to see progress here
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AnimatePresence mode="sync">
        {Object.entries(groupedItems).map(([type, items]) => (
          <motion.div
            key={type}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-4"
          >
            {/* Section Header */}
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-zinc-300 uppercase tracking-wider">
                {getSectionTitle(type)}
              </h3>
              <p className="text-xs text-gray-500 dark:text-zinc-500 mt-1">
                {getSectionDescription(type)}
              </p>
            </div>

            {/* Progress Cards */}
            <div className="space-y-3">
              {items.map((progressData) => (
                <CrawlingProgressCard
                  key={progressData.progressId}
                  progressId={progressData.progressId}
                  initialData={progressData}
                  onComplete={onProgressComplete}
                  onError={(error) => onProgressError(error, progressData.progressId)}
                  onRetry={() => onRetryProgress(progressData.progressId)}
                  onDismiss={() => onDismissProgress(progressData.progressId)}
                  onStop={() => onStopProgress(progressData.progressId)}
                />
              ))}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};