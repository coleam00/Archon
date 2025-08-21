/**
 * Type definitions for JSONB fields in the database
 * These replace the previous any[] types with proper discriminated unions
 */

/**
 * Document stored in project docs field
 */
export interface ProjectDocument {
  type: 'document';
  id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/**
 * Feature stored in project features field
 */
export interface ProjectFeature {
  type: 'feature';
  id: string;
  name: string;
  status: 'planned' | 'in-progress' | 'completed';
  description: string;
  priority?: number;
  assignee?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Data stored in project data field
 */
export interface ProjectData {
  type: 'data';
  key: string;
  value: unknown;
  timestamp: string;
  source?: string;
}

/**
 * Source reference for tasks
 */
export interface TaskSource {
  url?: string;
  file?: string;
  type: 'documentation' | 'code' | 'internal_docs' | 'external';
  relevance?: string;
  title?: string;
}

/**
 * Code example reference for tasks
 */
export interface TaskCodeExample {
  file: string;
  function?: string;
  class?: string;
  purpose: string;
  language?: string;
  snippet?: string;
}

/**
 * Union type for all JSONB content types
 */
export type JsonbContent = ProjectDocument | ProjectFeature | ProjectData;

/**
 * Re-export type guards from the canonical location
 * These use Zod schemas for validation which is more robust
 */
export { 
  isProjectDocument, 
  isProjectFeature, 
  isProjectData 
} from '../utils/typeGuards';