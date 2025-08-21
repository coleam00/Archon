/**
 * Type definitions for document content
 * Replaces 'any' types with proper typed unions
 */

/**
 * Markdown content stored as a string
 */
export interface MarkdownContent {
  type: 'markdown';
  markdown: string;
}

/**
 * PRP (Product Requirement Prompt) document content
 */
export interface PRPContent {
  type: 'prp';
  document_type: 'prp';
  title: string;
  version: string;
  author: string;
  date: string;
  status: 'draft' | 'review' | 'approved' | 'deprecated';
  goal?: string;
  why?: string[];
  what?: {
    description: string;
    success_criteria: string[];
    user_stories?: string[];
  };
  context?: {
    documentation?: Array<{ source: string; why: string }>;
    existing_code?: Array<{ file: string; purpose: string }>;
    gotchas?: string[];
    current_state?: string;
    dependencies?: string[];
    environment_variables?: string[];
  };
  implementation_blueprint?: Record<string, any>;
  validation?: Record<string, any>;
  additional_context?: Record<string, any>;
}

/**
 * Generic structured document content
 */
export interface StructuredContent {
  type: 'structured';
  [key: string]: any;
}

/**
 * Union type for all document content types
 */
export type DocumentContent = string | MarkdownContent | PRPContent | StructuredContent;

/**
 * Complete document interface with typed content
 */
export interface ProjectDocument {
  id: string;
  title: string;
  content?: DocumentContent;
  created_at: string;
  updated_at: string;
  document_type?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Type guard to check if content is markdown
 */
export function isMarkdownContent(content: unknown): content is MarkdownContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    (content as any).type === 'markdown' &&
    'markdown' in content
  );
}

/**
 * Type guard to check if content is PRP
 */
export function isPRPContent(content: unknown): content is PRPContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'document_type' in content &&
    (content as any).document_type === 'prp'
  );
}

/**
 * Type guard to check if content is structured
 */
export function isStructuredContent(content: unknown): content is StructuredContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    (content as any).type === 'structured'
  );
}

/**
 * Helper to extract markdown string from any content type
 */
export function getMarkdownFromContent(content: DocumentContent | undefined): string {
  if (!content) return '';
  
  if (typeof content === 'string') {
    return content;
  }
  
  if (isMarkdownContent(content)) {
    return content.markdown;
  }
  
  if (isPRPContent(content)) {
    // Convert PRP to markdown representation
    return convertPRPToMarkdown(content);
  }
  
  if (isStructuredContent(content)) {
    // Convert structured content to markdown
    return JSON.stringify(content, null, 2);
  }
  
  return '';
}

/**
 * Convert PRP content to markdown string
 */
function convertPRPToMarkdown(prp: PRPContent): string {
  let markdown = `# ${prp.title}\n\n`;
  
  // Add metadata
  markdown += `**Version:** ${prp.version}\n`;
  markdown += `**Author:** ${prp.author}\n`;
  markdown += `**Date:** ${prp.date}\n`;
  markdown += `**Status:** ${prp.status}\n\n`;
  
  // Add goal
  if (prp.goal) {
    markdown += `## Goal\n\n${prp.goal}\n\n`;
  }
  
  // Add why section
  if (prp.why && prp.why.length > 0) {
    markdown += `## Why\n\n`;
    prp.why.forEach(item => {
      markdown += `- ${item}\n`;
    });
    markdown += '\n';
  }
  
  // Add what section
  if (prp.what) {
    markdown += `## What\n\n${prp.what.description}\n\n`;
    
    if (prp.what.success_criteria && prp.what.success_criteria.length > 0) {
      markdown += `### Success Criteria\n\n`;
      prp.what.success_criteria.forEach(item => {
        markdown += `- ${item}\n`;
      });
      markdown += '\n';
    }
    
    if (prp.what.user_stories && prp.what.user_stories.length > 0) {
      markdown += `### User Stories\n\n`;
      prp.what.user_stories.forEach(item => {
        markdown += `- ${item}\n`;
      });
      markdown += '\n';
    }
  }
  
  // Add other sections as needed
  
  return markdown;
}