import React, { useState, useEffect } from 'react';
import { Plus, X, Search, Upload, Link as LinkIcon, Check, Brain, Save, History, Eye, Edit3, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { knowledgeBaseService, KnowledgeItem } from '../../services/knowledgeBaseService';
import { projectService } from '../../services/projectService';
import { useToast } from '../../contexts/ToastContext';
import { Input } from '../ui/Input';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { useCrawlProgressPolling } from '../../hooks/usePolling';
import { MilkdownEditor } from './MilkdownEditor';
import { VersionHistoryModal } from './VersionHistoryModal';
import { PRPViewer } from '../prp';
import { DocumentCard, NewDocumentCard } from './DocumentCard';




interface ProjectDoc {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  // Content field stores markdown or structured data
  content?: any;
  document_type?: string;
}

interface Task {
  id: string;
  title: string;
  feature: string;
  status: 'backlog' | 'in-progress' | 'review' | 'complete';
}

// Document Templates - Updated for proper MCP database storage
const DOCUMENT_TEMPLATES = {
  'prp_base': {
    name: 'Feature PRP Template',
    icon: '🚀',
    document_type: 'prp',
    content: {
      document_type: 'prp',
      title: 'New Feature Implementation',
      version: '1.0',
      author: 'User',
      date: new Date().toISOString().split('T')[0],
      status: 'draft',
      
      goal: 'Build a specific feature - replace with your goal',
      
      why: [
        'Business value this feature provides',
        'User problem this solves',
        'How it integrates with existing functionality'
      ],
      
      what: {
        description: 'Detailed description of what users will see and experience',
        success_criteria: [
          'Measurable outcome 1 (e.g., response time < 200ms)',
          'User behavior outcome 2 (e.g., 90% task completion rate)',
          'Technical outcome 3 (e.g., zero data loss during operations)'
        ],
        user_stories: [
          'As a [user type], I want to [action] so that [benefit]',
          'As a [user type], I need to [requirement] in order to [goal]'
        ]
      },
      
      context: {
        documentation: [
          {
            source: 'https://docs.example.com/api',
            why: 'API endpoints and data models needed'
          },
          {
            source: 'src/components/Example.tsx',
            why: 'Existing pattern to follow for UI components'
          }
        ],
        existing_code: [
          {
            file: 'src/services/baseService.ts',
            purpose: 'Service layer pattern to extend'
          }
        ],
        gotchas: [
          'Critical requirement or constraint to remember',
          'Common mistake to avoid during implementation'
        ],
        dependencies: [
          'Package or service that must be available',
          'Another feature that must be completed first'
        ]
      },
      
      implementation_blueprint: {
        phase_1_foundation: {
          description: 'Set up core infrastructure',
          duration: '2-3 days',
          tasks: [
            {
              title: 'Create TypeScript interfaces',
              details: 'Define all data types and API contracts',
              files: ['src/types/newFeature.ts']
            },
            {
              title: 'Set up database schema',
              details: 'Create tables and relationships if needed',
              files: ['migrations/add_feature_tables.sql']
            }
          ]
        },
        phase_2_implementation: {
          description: 'Build core functionality',
          duration: '1 week',
          tasks: [
            {
              title: 'Implement service layer',
              details: 'Business logic and data access',
              files: ['src/services/newFeatureService.ts']
            },
            {
              title: 'Create API endpoints',
              details: 'RESTful endpoints with proper validation',
              files: ['src/api/newFeatureApi.ts']
            },
            {
              title: 'Build UI components',
              details: 'React components with TypeScript',
              files: ['src/components/NewFeature.tsx']
            }
          ]
        },
        phase_3_integration: {
          description: 'Connect everything and test',
          duration: '2-3 days',
          tasks: [
            {
              title: 'Integrate frontend with backend',
              details: 'Connect UI to API endpoints',
              files: ['src/hooks/useNewFeature.ts']
            },
            {
              title: 'Add comprehensive tests',
              details: 'Unit, integration, and E2E tests',
              files: ['tests/newFeature.test.ts']
            }
          ]
        }
      },
      
      validation: {
        level_1_syntax: [
          'npm run lint -- --fix',
          'npm run typecheck',
          'Ensure no TypeScript errors'
        ],
        level_2_unit_tests: [
          'npm run test -- newFeature',
          'Verify all unit tests pass with >80% coverage'
        ],
        level_3_integration: [
          'npm run test:integration',
          'Test API endpoints with proper data flow'
        ],
        level_4_end_to_end: [
          'Start development server and test user flows',
          'Verify feature works as expected in browser',
          'Test error scenarios and edge cases'
        ]
      }
    }
  },
  'prp_task': {
    name: 'Task/Bug Fix PRP',
    icon: '✅',
    document_type: 'prp',
    content: {
      document_type: 'prp',
      title: 'Task or Bug Fix',
      version: '1.0',
      author: 'User',
      date: new Date().toISOString().split('T')[0],
      status: 'draft',
      
      goal: 'Fix specific bug or complete targeted task',
      
      why: [
        'Impact on users or system if not fixed',
        'How this fits into larger project goals',
        'Priority level and urgency'
      ],
      
      what: {
        description: 'Specific problem to solve and expected outcome',
        current_behavior: 'What happens now (the problem)',
        expected_behavior: 'What should happen instead',
        acceptance_criteria: [
          'Specific testable condition 1',
          'Specific testable condition 2',
          'No regressions in existing functionality'
        ]
      },
      
      context: {
        affected_files: [
          {
            path: 'src/component.tsx',
            reason: 'Contains the bug or needs the change'
          },
          {
            path: 'src/service.ts',
            reason: 'Related logic that may need updates'
          }
        ],
        root_cause: 'Analysis of why this issue exists',
        related_issues: [
          'Link to GitHub issue or ticket',
          'Related bugs or enhancement requests'
        ],
        dependencies: [
          'Other tasks that must be completed first',
          'External services or APIs involved'
        ]
      },
      
      implementation_steps: [
        {
          step: 1,
          action: 'Reproduce the issue',
          details: 'Create test case that demonstrates the problem'
        },
        {
          step: 2,
          action: 'Identify root cause',
          details: 'Debug and trace the issue to its source'
        },
        {
          step: 3,
          action: 'Implement fix',
          details: 'Apply minimal change that resolves the issue'
        },
        {
          step: 4,
          action: 'Test solution',
          details: 'Verify fix works and doesn\'t break other functionality'
        },
        {
          step: 5,
          action: 'Update documentation',
          details: 'Update any relevant docs or comments'
        }
      ],
      
      validation: {
        reproduction_test: [
          'Steps to reproduce the original issue',
          'Verify the issue no longer occurs'
        ],
        regression_tests: [
          'Run existing test suite to ensure no regressions',
          'Test related functionality manually'
        ],
        edge_cases: [
          'Test boundary conditions',
          'Test error scenarios'
        ]
      }
    }
  },
  'prp_planning': {
    name: 'Architecture/Planning PRP',
    icon: '📐',
    document_type: 'prp',
    content: {
      document_type: 'prp',
      title: 'System Architecture and Planning',
      version: '1.0',
      author: 'User',
      date: new Date().toISOString().split('T')[0],
      status: 'draft',
      
      goal: 'Design and plan system architecture for [specific system/feature]',
      
      why: [
        'Strategic business objective driving this architecture',
        'Technical debt or scalability issues to address',
        'Future growth and maintainability requirements'
      ],
      
      what: {
        scope: 'System boundaries, affected components, and integration points',
        deliverables: [
          'Comprehensive architecture documentation',
          'Component specifications and interfaces',
          'Implementation roadmap and timeline',
          'Migration/deployment strategy'
        ],
        constraints: [
          'Budget and timeline limitations',
          'Technical constraints and dependencies',
          'Regulatory or compliance requirements'
        ]
      },
      
      current_state_analysis: {
        strengths: [
          'What works well in the current system',
          'Stable components that should be preserved',
          'Existing patterns worth maintaining'
        ],
        weaknesses: [
          'Performance bottlenecks and limitations',
          'Maintenance and scaling challenges',
          'Security or reliability concerns'
        ],
        opportunities: [
          'Modern technologies to leverage',
          'Process improvements to implement',
          'Business capabilities to enable'
        ],
        threats: [
          'Risks during transition period',
          'Dependencies on legacy systems',
          'Resource and timeline constraints'
        ]
      },
      
      proposed_architecture: {
        overview: 'High-level description of the new architecture',
        components: {
          frontend: {
            technology: 'React 18 with TypeScript',
            patterns: 'Component composition with ShadCN UI',
            state_management: 'React hooks with context for global state'
          },
          backend: {
            technology: 'FastAPI with async Python',
            patterns: 'Service layer with repository pattern',
            database: 'Supabase PostgreSQL with proper indexing'
          },
          realtime: {
            technology: 'HTTP polling for live updates',
            patterns: 'ETag-based polling with smart pausing'
          },
          infrastructure: {
            deployment: 'Docker containers with orchestration',
            monitoring: 'Comprehensive logging and metrics',
            security: 'OAuth2 with proper encryption'
          }
        },
        data_flow: [
          'User interaction → Frontend validation → API call',
          'Backend processing → Database operations → Response',
          'Real-time events → HTTP polling → UI updates'
        ],
        integration_points: [
          'External APIs and their usage patterns',
          'Third-party services and data sources',
          'Legacy system interfaces'
        ]
      },
      
      implementation_phases: {
        phase_1_foundation: {
          duration: '2-3 weeks',
          objective: 'Core infrastructure and basic functionality',
          deliverables: [
            'Database schema and basic API endpoints',
            'Authentication and authorization system',
            'Core UI components and routing'
          ],
          success_criteria: [
            'Basic user flows working end-to-end',
            'Core API responses under 200ms',
            'Authentication working with test users'
          ]
        },
        phase_2_features: {
          duration: '3-4 weeks',
          objective: 'Primary feature implementation',
          deliverables: [
            'Complete feature set with UI',
            'Real-time updates and notifications',
            'Data validation and error handling'
          ],
          success_criteria: [
            'All major user stories implemented',
            'Real-time features working reliably',
            'Comprehensive error handling'
          ]
        },
        phase_3_optimization: {
          duration: '1-2 weeks',
          objective: 'Testing, optimization, and deployment',
          deliverables: [
            'Comprehensive test suite',
            'Performance optimization',
            'Production deployment'
          ],
          success_criteria: [
            'Test coverage >80%',
            'Performance targets met',
            'Successful production deployment'
          ]
        }
      },
      
      success_metrics: {
        performance: [
          'API response time <200ms for 95% of requests',
          'UI load time <2 seconds',
          'Support 1000+ concurrent users'
        ],
        quality: [
          'Test coverage >80%',
          'Zero critical security vulnerabilities',
          'Mean time to recovery <15 minutes'
        ],
        business: [
          'User task completion rate >90%',
          'Feature adoption >60% within first month',
          'User satisfaction score >4.5/5'
        ]
      },
      
      risks_and_mitigation: {
        technical_risks: [
          {
            risk: 'Integration complexity with legacy systems',
            mitigation: 'Phased approach with fallback options'
          },
          {
            risk: 'Performance issues at scale',
            mitigation: 'Load testing and optimization in early phases'
          }
        ],
        business_risks: [
          {
            risk: 'Timeline delays due to scope creep',
            mitigation: 'Clear requirements and change control process'
          }
        ]
      }
    }
  },
  
  // Simple markdown templates for non-PRP documents
  'markdown_doc': {
    name: 'Markdown Document',
    icon: '📝',
    document_type: 'markdown',
    content: {
      markdown: `# Document Title

## Overview

Provide a brief overview of this document...

## Content

Add your content here...

## Next Steps

- [ ] Action item 1
- [ ] Action item 2`
    }
  },
  
  'meeting_notes': {
    name: 'Meeting Notes',
    icon: '📋',
    document_type: 'meeting_notes',
    content: {
      meeting_date: new Date().toISOString().split('T')[0],
      attendees: ['Person 1', 'Person 2'],
      agenda: [
        'Agenda item 1',
        'Agenda item 2'
      ],
      notes: 'Meeting discussion notes...',
      action_items: [
        {
          item: 'Action item 1',
          owner: 'Person Name',
          due_date: 'YYYY-MM-DD'
        }
      ],
      next_meeting: 'YYYY-MM-DD'
    }
  }
};

/* ——————————————————————————————————————————— */
/* Main component                                 */
/* ——————————————————————————————————————————— */
export const DocsTab = ({
  tasks,
  project
}: {
  tasks: Task[];
  project?: {
    id: string;
    title: string;
    created_at?: string;
    updated_at?: string;
  } | null;
}) => {
  // Document state
  const [documents, setDocuments] = useState<ProjectDoc[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<ProjectDoc | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [viewMode, setViewMode] = useState<'beautiful' | 'markdown'>('beautiful');
  
  // Dark mode detection
  const [isDarkMode, setIsDarkMode] = useState(false);
  
  useEffect(() => {
    const checkDarkMode = () => {
      const htmlElement = document.documentElement;
      const hasDarkClass = htmlElement.classList.contains('dark');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDarkMode(hasDarkClass || prefersDark);
    };
    
    checkDarkMode();
    
    // Listen for changes
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', checkDarkMode);
    
    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener('change', checkDarkMode);
    };
  }, []);
  
  // Knowledge management state
  const [showTechnicalModal, setShowTechnicalModal] = useState(false);
  const [showBusinessModal, setShowBusinessModal] = useState(false);
  const [selectedTechnicalSources, setSelectedTechnicalSources] = useState<string[]>([]);
  const [selectedBusinessSources, setSelectedBusinessSources] = useState<string[]>([]);
  const [showAddSourceModal, setShowAddSourceModal] = useState(false);
  const [sourceType, setSourceType] = useState<'technical' | 'business'>('technical');
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [activeProgressId, setActiveProgressId] = useState<string | null>(null);
  const { showToast } = useToast();
  
  // Poll for crawl progress
  const crawlProgress = useCrawlProgressPolling(activeProgressId);

  // Load project documents from the project data
  const loadProjectDocuments = async () => {
    if (!project?.id || !project.docs) return;
    
    try {
      setLoading(true);
      
      // Use the docs directly from the project data
      const projectDocuments: ProjectDoc[] = project.docs.map((doc: any) => ({
        id: doc.id,
        title: doc.title || 'Untitled Document',
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        content: doc.content,
        document_type: doc.document_type || 'document'
      }));
      
      setDocuments(projectDocuments);
      
      // Auto-select first document if available and no document is currently selected
      if (projectDocuments.length > 0 && !selectedDocument) {
        setSelectedDocument(projectDocuments[0]);
      }
      
      console.log(`Loaded ${projectDocuments.length} documents from project data`);
    } catch (error) {
      console.error('Failed to load documents:', error);
      showToast('Failed to load documents', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Create new document from template
  const createDocumentFromTemplate = async (templateKey: string) => {
    if (!project?.id) return;
    
    const template = DOCUMENT_TEMPLATES[templateKey as keyof typeof DOCUMENT_TEMPLATES];
    if (!template) return;

    try {
      setIsSaving(true);
      
      // Create the document in the database first
      const newDocument = await projectService.createDocument(project.id, {
        title: template.name,
        content: template.content,
        document_type: template.document_type,
        tags: []
      });
      
      // Add to documents list with the real document from the database
      setDocuments(prev => [...prev, newDocument]);
      setSelectedDocument(newDocument);
      
      console.log('Document created successfully:', newDocument);
      showToast('Document created successfully', 'success');
      setShowTemplateModal(false);
    } catch (error) {
      console.error('Failed to create document:', error);
      showToast(
        error instanceof Error ? error.message : 'Failed to create document', 
        'error'
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Save document changes
  const saveDocument = async () => {
    if (!selectedDocument || !project?.id) return;

    try {
      setIsSaving(true);
      
      // Call backend API to persist changes
      const updatedDocument = await projectService.updateDocument(
        project.id,
        selectedDocument.id,
        {
          title: selectedDocument.title,
          content: selectedDocument.content,
          tags: selectedDocument.tags,
          author: selectedDocument.author
        }
      );
      
      // Update local state with backend response
      setDocuments(prev => prev.map(doc => 
        doc.id === selectedDocument.id ? updatedDocument : doc
      ));
      setSelectedDocument(updatedDocument);
      
      console.log('Document saved successfully:', updatedDocument);
      showToast('Document saved successfully', 'success');
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save document:', error);
      showToast(
        error instanceof Error ? error.message : 'Failed to save document', 
        'error'
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Note: Block editing functions removed - now handled by BlockNoteEditor internally

  // Load project data including linked sources
  const loadProjectData = async () => {
    if (!project?.id) return;
    
    try {
      const response = await fetch(`/api/projects/${project.id}`);
      if (!response.ok) throw new Error('Failed to load project data');
      
      const projectData = await response.json();
      
      // Initialize selected sources from saved project data
      const technicalSourceIds = (projectData.technical_sources || []).map((source: any) => source.source_id);
      const businessSourceIds = (projectData.business_sources || []).map((source: any) => source.source_id);
      
      setSelectedTechnicalSources(technicalSourceIds);
      setSelectedBusinessSources(businessSourceIds);
      
      console.log('Loaded project sources:', {
        technical: technicalSourceIds,
        business: businessSourceIds
      });
    } catch (error) {
      console.error('Failed to load project data:', error);
      showToast('Failed to load project sources', 'error');
    }
  };

  // Load knowledge items and documents on mount
  useEffect(() => {
    loadKnowledgeItems();
    loadProjectDocuments();
    loadProjectData(); // Load saved sources
    
    // Cleanup function
    return () => {
      console.log('🧹 DocsTab: Cleanup');
      // Polling cleanup happens automatically in hooks
    };
  }, [project?.id]);

  // Clear selected document when project changes
  useEffect(() => {
    setSelectedDocument(null);
  }, [project?.id]);

  // Handle crawl progress updates
  useEffect(() => {
    if (crawlProgress.data) {
      const status = crawlProgress.data.status;
      console.log('📊 Crawl progress update:', crawlProgress.data);
      
      if (status === 'completed') {
        showToast('Crawling completed successfully', 'success');
        loadKnowledgeItems(); // Reload knowledge items
        setActiveProgressId(null); // Clear active progress
      } else if (status === 'failed' || status === 'error') {
        const errorMsg = crawlProgress.data.error || 'Crawling failed';
        showToast(`Crawling failed: ${errorMsg}`, 'error');
        setActiveProgressId(null); // Clear active progress
      }
    }
  }, [crawlProgress.data, showToast]);

  // Existing knowledge loading function
  const loadKnowledgeItems = async (knowledgeType?: 'technical' | 'business') => {
    try {
      setLoading(true);
      const response = await knowledgeBaseService.getKnowledgeItems({
        knowledge_type: knowledgeType,
        page: 1,
        per_page: 50
      });
      setKnowledgeItems(response.items);
    } catch (error) {
      console.error('Failed to load knowledge items:', error);
      showToast('Failed to load knowledge items', 'error');
      setKnowledgeItems([]);
    } finally {
      setLoading(false);
    }
  };

  // Knowledge management helper functions (simplified for brevity)
  const transformToLegacyFormat = (items: KnowledgeItem[]) => {
    return items.map(item => ({
      id: item.id,
      title: item.title,
      type: item.metadata.source_type || 'url',
      lastUpdated: new Date(item.updated_at).toLocaleDateString()
    }));
  };

  const technicalSources = transformToLegacyFormat(
    knowledgeItems.filter(item => item.metadata.knowledge_type === 'technical')
  );
  
  const businessSources = transformToLegacyFormat(
    knowledgeItems.filter(item => item.metadata.knowledge_type === 'business')
  );

  const toggleTechnicalSource = (id: string) => {
    setSelectedTechnicalSources(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };
  const toggleBusinessSource = (id: string) => {
    setSelectedBusinessSources(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };
  const saveTechnicalSources = async () => {
    if (!project?.id) return;
    
    try {
      await projectService.updateProject(project.id, {
        technical_sources: selectedTechnicalSources
      });
      showToast('Technical sources updated successfully', 'success');
      setShowTechnicalModal(false);
      // Reload project data to reflect the changes
      await loadProjectData();
    } catch (error) {
      console.error('Failed to save technical sources:', error);
      showToast('Failed to update technical sources', 'error');
    }
  };
  
  const saveBusinessSources = async () => {
    if (!project?.id) return;
    
    try {
      await projectService.updateProject(project.id, {
        business_sources: selectedBusinessSources
      });
      showToast('Business sources updated successfully', 'success');
      setShowBusinessModal(false);
      // Reload project data to reflect the changes
      await loadProjectData();
    } catch (error) {
      console.error('Failed to save business sources:', error);
      showToast('Failed to update business sources', 'error');
    }
  };

  const handleStartCrawl = async (progressId: string, initialData: any) => {
    console.log(`🚀 Starting crawl tracking for: ${progressId}`);
    setActiveProgressId(progressId);
    showToast('Crawling started - tracking progress', 'success');
  };

  const openAddSourceModal = (type: 'technical' | 'business') => {
    setSourceType(type);
    setShowAddSourceModal(true);
  };

  return (
    <div className="relative min-h-[70vh] pt-8">
      <div className="max-w-6xl pl-8">
        {/* Document Header */}
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text mb-2">
                Project Docs
              </h2>
              <p className="text-gray-400">{project?.title || 'No project selected'}</p>
            </div>
            
            {/* View mode and action buttons */}
            <div className="flex items-center gap-4">
              {selectedDocument && (
                <div className="flex items-center gap-2">
                  {/* View mode toggle for all documents */}
                  <div className="flex items-center gap-1 bg-white/50 dark:bg-black/30 rounded-lg p-1 border border-gray-300 dark:border-gray-700">
                      <button
                        onClick={() => setViewMode('beautiful')}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                          viewMode === 'beautiful' 
                            ? 'bg-blue-500 text-white shadow-lg' 
                            : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white'
                        }`}
                      >
                        <Sparkles className="w-4 h-4" />
                        Beautiful
                      </button>
                      <button
                        onClick={() => setViewMode('markdown')}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                          viewMode === 'markdown' 
                            ? 'bg-purple-500 text-white shadow-lg' 
                            : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white'
                        }`}
                      >
                        <Edit3 className="w-4 h-4" />
                        Markdown
                      </button>
                    </div>
                  
                  {isEditing && (
                    <Button 
                      onClick={saveDocument} 
                      disabled={isSaving}
                      variant="primary" 
                      accentColor="green"
                      className="flex items-center gap-2"
                    >
                      <Save className="w-4 h-4" />
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                  )}
                </div>
              )}

              <Button
                onClick={() => setShowVersionHistory(true)}
                variant="outline"
                className="flex items-center gap-2"
              >
                <History className="w-4 h-4" />
                History
              </Button>
            </div>
          </div>
        </header>

        {/* Document Cards Container */}
        <div className="relative mb-6">
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
            {documents.map(doc => (
              <DocumentCard
                key={doc.id}
                document={doc}
                isActive={selectedDocument?.id === doc.id}
                onSelect={setSelectedDocument}
                onDelete={async (docId) => {
                  try {
                    // Call API to delete from database first
                    await projectService.deleteDocument(project.id, docId);
                    
                    // Then remove from local state
                    setDocuments(prev => prev.filter(d => d.id !== docId));
                    if (selectedDocument?.id === docId) {
                      setSelectedDocument(documents.find(d => d.id !== docId) || null);
                    }
                    showToast('Document deleted', 'success');
                  } catch (error) {
                    console.error('Failed to delete document:', error);
                    showToast('Failed to delete document', 'error');
                  }
                }}
                isDarkMode={isDarkMode}
              />
            ))}
            
            {/* Add New Document Card */}
            <NewDocumentCard onClick={() => setShowTemplateModal(true)} />
          </div>
        </div>

        {/* Document Content */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-gray-500">Loading documents...</div>
          </div>
        ) : selectedDocument ? (
          // Show PRPViewer in beautiful mode for all documents
          viewMode === 'beautiful' ? (
            <div className="mb-8">
              <PRPViewer 
                content={selectedDocument.content || {}} 
                isDarkMode={isDarkMode}
              />
            </div>
          ) : (
            <MilkdownEditor
              document={selectedDocument}
              isDarkMode={isDarkMode}
              onSave={async (updatedDocument) => {
                try {
                  setIsSaving(true);
                  
                  // Call backend API to persist changes
                  const savedDocument = await projectService.updateDocument(
                    project.id,
                    updatedDocument.id,
                    {
                      title: updatedDocument.title,
                      content: updatedDocument.content,
                      tags: updatedDocument.tags,
                      author: updatedDocument.author
                    }
                  );
                  
                  // Update local state with backend response
                  setSelectedDocument(savedDocument);
                  setDocuments(prev => prev.map(doc => 
                    doc.id === updatedDocument.id ? savedDocument : doc
                  ));
                  
                  console.log('Document saved via MilkdownEditor');
                  showToast('Document saved successfully', 'success');
                } catch (error) {
                  console.error('Failed to save document:', error);
                  showToast(
                    error instanceof Error ? error.message : 'Failed to save document',
                    'error'
                  );
                } finally {
                  setIsSaving(false);
                }
              }}
              className="mb-8"
            />
          )
        ) : (
          <div className="flex flex-col items-center justify-center h-64 text-gray-500">
            <Brain className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg mb-2">No documents found</p>
            <p className="text-sm">Create a new document to get started</p>
          </div>
        )}

        {/* Knowledge Sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-12">
          <KnowledgeSection 
            title="Technical Knowledge" 
            color="blue" 
            sources={selectedTechnicalSources.map(id => technicalSources.find(source => source.id === id))} 
            onAddClick={() => setShowTechnicalModal(true)} 
          />
          <KnowledgeSection 
            title="Business Knowledge" 
            color="purple" 
            sources={selectedBusinessSources.map(id => businessSources.find(source => source.id === id))} 
            onAddClick={() => setShowBusinessModal(true)} 
          />
        </div>
      </div>

      {/* Template Selection Modal */}
      {showTemplateModal && (
        <TemplateModal
          onClose={() => setShowTemplateModal(false)}
          onSelectTemplate={createDocumentFromTemplate}
          isCreating={isSaving}
        />
      )}

      {/* Existing Modals (simplified for brevity) */}
      {showTechnicalModal && (
        <SourceSelectionModal 
          title="Select Technical Knowledge Sources" 
          sources={technicalSources} 
          selectedSources={selectedTechnicalSources} 
          onToggleSource={toggleTechnicalSource} 
          onSave={saveTechnicalSources} 
          onClose={() => setShowTechnicalModal(false)} 
          onAddSource={() => openAddSourceModal('technical')} 
        />
      )}
      
      {showBusinessModal && (
        <SourceSelectionModal 
          title="Select Business Knowledge Sources" 
          sources={businessSources} 
          selectedSources={selectedBusinessSources} 
          onToggleSource={toggleBusinessSource} 
          onSave={saveBusinessSources} 
          onClose={() => setShowBusinessModal(false)} 
          onAddSource={() => openAddSourceModal('business')} 
        />
      )}
      
      {showAddSourceModal && (
        <AddKnowledgeModal 
          sourceType={sourceType}
          onClose={() => setShowAddSourceModal(false)} 
          onSuccess={() => {
            loadKnowledgeItems();
            setShowAddSourceModal(false);
          }}
          onStartCrawl={handleStartCrawl}
        />
      )}

      {/* Version History Modal */}
      {showVersionHistory && project && (
        <VersionHistoryModal
          projectId={project.id}
          fieldName="docs"
          documentId={selectedDocument?.id}
          isOpen={showVersionHistory}
          onClose={() => setShowVersionHistory(false)}
          onRestore={() => {
            // Reload documents after restore
            loadProjectDocuments();
            setShowVersionHistory(false);
          }}
        />
      )}
    </div>
  );
};


/* ——————————————————————————————————————————— */
/* Helper components                              */
/* ——————————————————————————————————————————— */

// ArchonEditor component removed - replaced with BlockNoteEditor

// Template Modal Component
const TemplateModal: React.FC<{
  onClose: () => void;
  onSelectTemplate: (templateKey: string) => void;
  isCreating: boolean;
}> = ({ onClose, onSelectTemplate, isCreating }) => {
  const templates = Object.entries(DOCUMENT_TEMPLATES);

  const getTemplateDescription = (key: string, template: any) => {
    const descriptions: Record<string, string> = {
      'prp_base': 'Comprehensive template for implementing new features with full context, validation loops, and structured implementation blueprint.',
      'prp_task': 'Focused template for specific tasks or bug fixes with clear steps and validation criteria.',
      'prp_planning': 'Strategic template for architecture planning and system design with risk analysis and success metrics.',
      'markdown_doc': 'Simple markdown document for general documentation and notes.',
      'meeting_notes': 'Structured template for meeting notes with attendees, agenda, and action items.'
    };
    return descriptions[key] || 'Document template';
  };

  return (
    <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-2xl
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-blue-500 
          before:shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]">
        
        <div className="relative z-10">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text">
              Choose a Template
            </h3>
            <button onClick={onClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {templates.map(([key, template]) => (
              <button
                key={key}
                onClick={() => onSelectTemplate(key)}
                disabled={isCreating}
                className="p-4 text-left border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl flex-shrink-0 group-hover:scale-110 transition-transform">{template.icon}</span>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-1">{template.name}</h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                      {getTemplateDescription(key, template)}
                    </p>
                    {template.document_type === 'prp' && (
                      <div className="mt-2">
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200">
                          PRP Template
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {isCreating && (
            <div className="mt-4 flex items-center justify-center gap-2 text-blue-500">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm">Creating document...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const KnowledgeSection: React.FC<{
  title: string;
  color: 'blue' | 'purple' | 'pink' | 'orange';
  sources: any[];
  onAddClick: () => void;
}> = ({
  title,
  color,
  sources = [],
  onAddClick
}) => {
  const colorMap = {
    blue: {
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/30',
      text: 'text-blue-600 dark:text-blue-400',
      buttonBg: 'bg-blue-500/20',
      buttonHover: 'hover:bg-blue-500/30',
      buttonBorder: 'border-blue-500/40',
      buttonShadow: 'hover:shadow-[0_0_15px_rgba(59,130,246,0.3)]'
    },
    purple: {
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/30',
      text: 'text-purple-600 dark:text-purple-400',
      buttonBg: 'bg-purple-500/20',
      buttonHover: 'hover:bg-purple-500/30',
      buttonBorder: 'border-purple-500/40',
      buttonShadow: 'hover:shadow-[0_0_15px_rgba(168,85,247,0.3)]'
    },
    pink: {
      bg: 'bg-pink-500/10',
      border: 'border-pink-500/30',
      text: 'text-pink-600 dark:text-pink-400',
      buttonBg: 'bg-pink-500/20',
      buttonHover: 'hover:bg-pink-500/30',
      buttonBorder: 'border-pink-500/40',
      buttonShadow: 'hover:shadow-[0_0_15px_rgba(236,72,153,0.3)]'
    },
    orange: {
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/30',
      text: 'text-orange-600 dark:text-orange-400',
      buttonBg: 'bg-orange-500/20',
      buttonHover: 'hover:bg-orange-500/30',
      buttonBorder: 'border-orange-500/40',
      buttonShadow: 'hover:shadow-[0_0_15px_rgba(249,115,22,0.3)]'
    }
  };
  return <section>
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-bold text-gray-800 dark:text-white flex items-center">
          <span className={`w-2 h-2 rounded-full bg-${color}-400 shadow-[0_0_8px_rgba(59,130,246,0.6)] mr-2`} />
          {title}
        </h3>
        <button onClick={onAddClick} className={`px-3 py-1.5 rounded-md ${colorMap[color].buttonBg} ${colorMap[color].buttonHover} border ${colorMap[color].buttonBorder} ${colorMap[color].text} ${colorMap[color].buttonShadow} transition-all duration-300 flex items-center gap-2`}>
          <Plus className="w-4 h-4" />
          <span className="text-sm">Add Sources</span>
        </button>
      </div>
      <div className={`bg-white/10 dark:bg-black/30 border ${colorMap[color].border} rounded-lg p-4 backdrop-blur-sm relative overflow-hidden min-h-[200px]`}>
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-blue-500/30"></div>
        {sources && sources.length > 0 ? <div className="space-y-3">
            {sources.map(source => source && <div key={source.id} className="flex items-center gap-3 p-2 rounded-md bg-white/10 dark:bg-black/30 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 transition-all">
                    {source.type === 'url' ? <LinkIcon className="w-4 h-4 text-blue-600 dark:text-blue-400" /> : <Upload className="w-4 h-4 text-pink-600 dark:text-pink-400" />}
                    <div className="flex-1">
                      <div className="text-gray-800 dark:text-white text-sm font-medium">
                        {source.title}
                      </div>
                      <div className="text-gray-500 text-xs">
                        Updated {source.lastUpdated}
                      </div>
                    </div>
                  </div>)}
          </div> : <div className="flex flex-col items-center justify-center h-[150px] text-gray-500">
            <p className="mb-2">No knowledge sources added yet</p>
            <p className="text-sm">
              Click "Add Sources" to select relevant documents
            </p>
          </div>}
      </div>
    </section>;
};

const SourceSelectionModal: React.FC<{
  title: string;
  sources: any[];
  selectedSources: string[];
  onToggleSource: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
  onAddSource: () => void;
}> = ({
  title,
  sources,
  selectedSources,
  onToggleSource,
  onSave,
  onClose,
  onAddSource
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  // Filter sources based on search query
  const filteredSources = sources.filter(source => source.title.toLowerCase().includes(searchQuery.toLowerCase()));
  return <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-3xl
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-blue-500 
          before:shadow-[0_0_10px_2px_rgba(59,130,246,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(59,130,246,0.7)]
          after:content-[''] after:absolute after:top-0 after:left-0 after:right-0 after:h-16
          after:bg-gradient-to-b after:from-blue-100 after:to-white dark:after:from-blue-500/20 dark:after:to-blue-500/5
          after:rounded-t-md after:pointer-events-none">
        <div className="relative z-10">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text">
              {title}
            </h3>
            <button onClick={onClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Search and Add Source */}
          <div className="flex gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 w-4 h-4" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search sources..." className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white rounded-md py-2 pl-10 pr-3 focus:outline-none focus:border-blue-400 focus:shadow-[0_0_10px_rgba(59,130,246,0.2)] transition-all duration-300" />
            </div>
            <Button onClick={onAddSource} variant="primary" accentColor="blue" className="shadow-lg shadow-blue-500/20">
              <Plus className="w-4 h-4 mr-2 inline" />
              <span>Add Source</span>
            </Button>
          </div>
          {/* Sources List */}
          <div className="bg-white/50 dark:bg-black/50 border border-gray-200 dark:border-gray-800 rounded-md p-2 max-h-[50vh] overflow-y-auto mb-6">
            {filteredSources.length > 0 ? <div className="space-y-2">
                {filteredSources.map(source => <div key={source.id} onClick={() => onToggleSource(source.id)} className={`flex items-center gap-3 p-3 rounded-md cursor-pointer transition-all duration-200 
                      ${selectedSources.includes(source.id) ? 'bg-blue-100/80 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-500/50' : 'bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'}`}>
                    <div className={`w-5 h-5 rounded-md border flex items-center justify-center 
                        ${selectedSources.includes(source.id) ? 'bg-blue-500 border-blue-500' : 'border-gray-400 dark:border-gray-600'}`}>
                      {selectedSources.includes(source.id) && <Check className="w-3 h-3 text-white" />}
                    </div>
                    {source.type === 'url' ? <LinkIcon className="w-4 h-4 text-blue-600 dark:text-blue-400" /> : <Upload className="w-4 h-4 text-pink-600 dark:text-pink-400" />}
                    <div className="flex-1">
                      <div className="text-gray-800 dark:text-white text-sm font-medium">
                        {source.title}
                      </div>
                      <div className="text-gray-500 dark:text-gray-500 text-xs">
                        Updated {source.lastUpdated}
                      </div>
                    </div>
                  </div>)}
              </div> : <div className="flex items-center justify-center h-32 text-gray-500 dark:text-gray-500">
                No sources found matching your search
              </div>}
          </div>
          {/* Action Buttons */}
          <div className="flex justify-end gap-3">
            <Button onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button onClick={onSave} variant="primary" accentColor="blue" className="shadow-lg shadow-blue-500/20">
              Save Selected ({selectedSources.length})
            </Button>
          </div>
        </div>
      </div>
    </div>;
};

interface AddKnowledgeModalProps {
  sourceType: 'technical' | 'business';
  onClose: () => void;
  onSuccess: () => void;
  onStartCrawl: (progressId: string, initialData: any) => void;
}

const AddKnowledgeModal = ({
  sourceType,
  onClose,
  onSuccess,
  onStartCrawl
}: AddKnowledgeModalProps) => {
  const [method, setMethod] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [updateFrequency, setUpdateFrequency] = useState('7');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async () => {
    try {
      setLoading(true);
      
      if (method === 'url') {
        if (!url.trim()) {
          showToast('Please enter a URL', 'error');
          return;
        }
        
        const result = await knowledgeBaseService.crawlUrl({
          url: url.trim(),
          knowledge_type: sourceType,
          tags,
          update_frequency: parseInt(updateFrequency)
        });
        
        // Check if result contains a progressId for progress tracking
        if ((result as any).progressId) {
          // Start progress tracking via polling
          onStartCrawl((result as any).progressId, {
            currentUrl: url.trim(),
            totalPages: 0,
            processedPages: 0
          });
          
          showToast('Crawling started - tracking progress', 'success');
          onClose(); // Close modal immediately
        } else {
          // Fallback for immediate response
          showToast((result as any).message || 'Crawling started', 'success');
          onSuccess();
        }
      } else {
        if (!selectedFile) {
          showToast('Please select a file', 'error');
          return;
        }
        
        const result = await knowledgeBaseService.uploadDocument(selectedFile, {
          knowledge_type: sourceType,
          tags
        });
        
        showToast((result as any).message || 'Document uploaded successfully', 'success');
        onSuccess();
      }
    } catch (error) {
      console.error('Failed to add knowledge:', error);
      showToast('Failed to add knowledge source', 'error');
    } finally {
      setLoading(false);
    }
  };

  return <div className="fixed inset-0 bg-gray-500/50 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      <Card className="w-full max-w-2xl relative before:content-[''] before:absolute before:top-0 before:left-0 before:w-full before:h-[1px] before:bg-green-500">
        <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-6">
          Add {sourceType === 'technical' ? 'Technical' : 'Business'} Knowledge Source
        </h2>
        
        {/* Source Type Selection */}
        <div className="flex gap-4 mb-6">
          <button onClick={() => setMethod('url')} className={`flex-1 p-4 rounded-md border ${method === 'url' ? 'border-blue-500 text-blue-600 dark:text-blue-500 bg-blue-50 dark:bg-blue-500/5' : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-blue-300 dark:hover:border-blue-500/30'} transition flex items-center justify-center gap-2`}>
            <LinkIcon className="w-4 h-4" />
            <span>URL / Website</span>
          </button>
          <button onClick={() => setMethod('file')} className={`flex-1 p-4 rounded-md border ${method === 'file' ? 'border-pink-500 text-pink-600 dark:text-pink-500 bg-pink-50 dark:bg-pink-500/5' : 'border-gray-200 dark:border-zinc-900 text-gray-500 dark:text-zinc-400 hover:border-pink-300 dark:hover:border-pink-500/30'} transition flex items-center justify-center gap-2`}>
            <Upload className="w-4 h-4" />
            <span>Upload File</span>
          </button>
        </div>
        
        {/* URL Input */}
        {method === 'url' && <div className="mb-6">
            <Input label="URL to Scrape" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." accentColor="blue" />
          </div>}
          
        {/* File Upload */}
        {method === 'file' && <div className="mb-6">
            <label htmlFor="file-upload" className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
              Upload Document
            </label>
            <input 
              id="file-upload"
              type="file"
              accept=".pdf,.md,.doc,.docx,.txt"
              onChange={e => setSelectedFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
            />
            <p className="text-gray-500 dark:text-zinc-600 text-sm mt-1">
              Supports PDF, MD, DOC up to 10MB
            </p>
          </div>}
          
        {/* Update Frequency */}
        {method === 'url' && <div className="mb-6">
            <Select label="Update Frequency" value={updateFrequency} onChange={e => setUpdateFrequency(e.target.value)} options={[{
          value: '1',
          label: 'Daily'
        }, {
          value: '7',
          label: 'Weekly'
        }, {
          value: '30',
          label: 'Monthly'
        }, {
          value: '0',
          label: 'Never'
        }]} accentColor="blue" />
          </div>}
          
        {/* Tags */}
        <div className="mb-6">
          <label className="block text-gray-600 dark:text-zinc-400 text-sm mb-2">
            Tags
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {tags.map(tag => <Badge key={tag} color="purple" variant="outline">
                {tag}
              </Badge>)}
          </div>
          <Input type="text" value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => {
          if (e.key === 'Enter' && newTag.trim()) {
            setTags([...tags, newTag.trim()]);
            setNewTag('');
          }
        }} placeholder="Add tags..." accentColor="purple" />
        </div>
        
        {/* Action Buttons */}
        <div className="flex justify-end gap-4">
          <Button onClick={onClose} variant="ghost" disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} variant="primary" accentColor={method === 'url' ? 'blue' : 'pink'} disabled={loading}>
            {loading ? 'Adding...' : 'Add Source'}
          </Button>
        </div>
      </Card>
    </div>;
};