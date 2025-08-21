import { ReactNode } from 'react';

// Base section types
export type SectionType = 
  | 'metadata'
  | 'context'
  | 'personas'
  | 'flows'
  | 'metrics'
  | 'plan'
  | 'list'
  | 'object'
  | 'keyvalue'
  | 'features'
  | 'generic';

export interface SectionProps {
  title: string;
  data: any;
  icon?: ReactNode;
  accentColor?: string;
  defaultOpen?: boolean;
  isDarkMode?: boolean;
  isCollapsible?: boolean;
  onToggle?: () => void;
  isOpen?: boolean;
}

// Alias for component compatibility
export type PRPSectionProps = SectionProps;

export interface PRPMetadata {
  title?: string;
  version?: string;
  author?: string;
  date?: string;
  status?: string;
  document_type?: string;
  [key: string]: any;
}

export interface PRPContext {
  scope?: string;
  background?: string;
  objectives?: string[];
  requirements?: any;
  [key: string]: any;
}

export interface PRPPersona {
  name?: string;
  role?: string;
  goals?: string[];
  pain_points?: string[];
  journey?: Record<string, any>;
  workflow?: Record<string, any>;
  [key: string]: any;
}

export interface PRPPhase {
  duration?: string;
  deliverables?: string[];
  tasks?: Array<{title: string; files: string[]; details: string}>;
  [key: string]: any;
}

export interface PRPContent {
  // Common fields
  title?: string;
  version?: string;
  author?: string;
  date?: string;
  status?: string;
  document_type?: string;
  
  // Section fields
  context?: PRPContext;
  user_personas?: Record<string, PRPPersona>;
  user_flows?: Record<string, any>;
  success_metrics?: Record<string, string[] | Record<string, any>>;
  implementation_plan?: Record<string, PRPPhase>;
  validation_gates?: Record<string, string[]>;
  technical_implementation?: Record<string, any>;
  ui_improvements?: Record<string, any>;
  information_architecture?: Record<string, any>;
  current_state_analysis?: Record<string, any>;
  component_architecture?: Record<string, any>;
  
  // Allow any other fields
  [key: string]: any;
}

export interface SectionDetectorResult {
  type: SectionType;
  confidence: number;
}

export interface SectionComponentProps extends SectionProps {
  content: PRPContent;
  sectionKey: string;
}

// Color maps for consistent theming
export const sectionColorMap: Record<string, string> = {
  metadata: 'blue',
  context: 'purple',
  personas: 'pink',
  flows: 'orange',
  metrics: 'green',
  plan: 'cyan',
  technical: 'indigo',
  validation: 'emerald',
  generic: 'gray'
};

// Icon size constants
export const ICON_SIZES = {
  section: 'w-5 h-5',
  subsection: 'w-4 h-4',
  item: 'w-3 h-3'
} as const;