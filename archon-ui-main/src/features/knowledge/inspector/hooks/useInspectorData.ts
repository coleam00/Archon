/**
 * Inspector Data Hook
 * Encapsulates data fetching and filtering logic for the inspector
 */

import { useMemo } from "react";
import { useKnowledgeChunks, useKnowledgeCodeExamples } from "../../hooks";
import type { CodeExample, DocumentChunk } from "../../types";

export interface UseInspectorDataProps {
  sourceId: string;
  searchQuery: string;
}

export interface UseInspectorDataResult {
  documents: {
    data: DocumentChunk[];
    filtered: DocumentChunk[];
    isLoading: boolean;
  };
  codeExamples: {
    data: CodeExample[];
    filtered: CodeExample[];
    isLoading: boolean;
  };
}

export function useInspectorData({ sourceId, searchQuery }: UseInspectorDataProps): UseInspectorDataResult {
  // Fetch documents and code examples with pagination (load first batch for initial display)
  const { data: documentsResponse, isLoading: docsLoading } = useKnowledgeChunks(sourceId, { limit: 100 });
  const { data: codeResponse, isLoading: codeLoading } = useKnowledgeCodeExamples(sourceId, { limit: 100 });

  const documentChunks = documentsResponse?.chunks || [];
  const codeList = codeResponse?.code_examples || [];

  // Filter documents based on search
  const filteredDocuments = useMemo(() => {
    if (!searchQuery) return documentChunks;

    const query = searchQuery.toLowerCase();
    return documentChunks.filter(
      (doc) =>
        doc.content?.toLowerCase().includes(query) ||
        doc.title?.toLowerCase().includes(query) ||
        doc.metadata?.title?.toLowerCase().includes(query) ||
        doc.metadata?.section?.toLowerCase().includes(query),
    );
  }, [documentChunks, searchQuery]);

  // Filter code examples based on search
  const filteredCode = useMemo(() => {
    if (!searchQuery) return codeList;

    const query = searchQuery.toLowerCase();
    return codeList.filter(
      (code) =>
        code.content?.toLowerCase().includes(query) ||
        code.summary?.toLowerCase().includes(query) ||
        code.language?.toLowerCase().includes(query) ||
        code.file_path?.toLowerCase().includes(query) ||
        code.title?.toLowerCase().includes(query),
    );
  }, [codeList, searchQuery]);

  return {
    documents: {
      data: documentChunks,
      filtered: filteredDocuments,
      isLoading: docsLoading,
    },
    codeExamples: {
      data: codeList,
      filtered: filteredCode,
      isLoading: codeLoading,
    },
  };
}
