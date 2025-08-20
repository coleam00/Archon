import React, { useEffect, useCallback, useState } from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './index.module.css';
import { 
    ArrowRight, 
    Database, 
    Zap, 
    Globe, 
    FileText, 
    Cpu, 
    CheckSquare,
    Plug
  } from 'lucide-react';
import Heading from '@theme/Heading';

// Architecture Diagram Component
const ArchitectureDiagram = () => {
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [lucideIcons, setLucideIcons] = useState(null);

  useEffect(() => {
    const loadComponents = async () => {
      if (typeof window !== 'undefined') {
        try {
          // Import React Flow CSS first
          await import('@xyflow/react/dist/style.css');
          
          const reactFlow = await import('@xyflow/react');
          const lucide = await import('lucide-react');
          setReactFlowInstance(reactFlow);
          setLucideIcons(lucide);
        } catch (error) {
          console.error('Error loading components:', error);
        }
      }
    };
    loadComponents();
  }, []);

  if (!reactFlowInstance || !lucideIcons) {
    return <div style={{ height: '600px', width: '100%' }}>Loading...</div>;
  }

  return <ReactFlowDiagram reactFlowInstance={reactFlowInstance} lucideIcons={lucideIcons} />;
};

// Separate component for React Flow diagram to ensure hooks are called consistently
const ReactFlowDiagram = ({ reactFlowInstance, lucideIcons }) => {
  const { ReactFlow, useNodesState, useEdgesState, addEdge, Handle, Position } = reactFlowInstance;
  const { Database, Zap, Globe, FileText, CheckSquare } = lucideIcons;

  // Node definitions with organized layout matching the screenshot
  const initialNodes = [
    // IDEs on the left (organized vertically)
    {
      id: 'cursor',
      type: 'ide',
      position: { x: 50, y: 50 },
      data: { label: 'Cursor', icon: '/img/cursor.svg' },
      draggable: false
    },
    {
      id: 'claude',
      type: 'ide', 
      position: { x: 50, y: 150 },
      data: { label: 'Claude Code', icon: '/img/claude-logo.svg' },
      draggable: false
    },
    {
      id: 'windsurf',
      type: 'ide',
      position: { x: 50, y: 250 },
      data: { label: 'Windsurf', icon: '/img/windsurf-white-symbol.svg' },
      draggable: false
    },
    {
      id: 'vscode',
      type: 'ide',
      position: { x: 50, y: 350 },
      data: { label: 'VS Code', icon: '/img/Visual_Studio_Code_1.35_icon.svg' },
      draggable: false
    },
    
    // Archon in the center (raised higher)
    {
      id: 'archon',
      type: 'archon',
      position: { x: 330, y: 50 },
      data: { label: 'ARCHON', subtitle: 'Knowledge Engine' },
      draggable: false
    },
    
    // MCP Logo positioned on connector line
    {
      id: 'mcp-logo',
      type: 'mcp',
      position: { x: 210, y: 135 },
      data: { label: 'MCP' },
      draggable: false
    },
    
    // FastApi Logo positioned on connector line
    {
      id: 'fastapi',
      type: 'fastapi',
      position: { x: 355, y: 275 },
      data: { label: 'FastAPI' },
      draggable: false
    },
    
    // Archon UI Control below Archon
    {
      id: 'archon-ui',
      type: 'ui-control',
      position: { x: 313, y: 350 },
      data: { 
        title: 'Archon UI',
        subtitle: 'Control all of Archon\'s Features'
      },
      draggable: false
    },
    
    // Knowledge Sources container
    {
      id: 'knowledge-sources',
      type: 'container',
      position: { x: 700, y: 50 },
      data: { 
        title: 'Knowledge Sources',
        type: 'knowledge',
        items: [
          { label: 'Web Crawling', icon: Globe },
          { label: 'Document Upload', icon: FileText },
          { label: 'Advanced RAG', icon: Zap },
          { label: 'Semantic Search', icon: Database }
        ]
      },
      draggable: false
    },
    
    // Project Intelligence container
    {
      id: 'project-intelligence',
      type: 'container',
      position: { x: 700, y: 300 },
      data: { 
        title: 'Project Intelligence',
        type: 'intelligence',
        items: [
          { label: 'PRD Management', icon: FileText },
          { label: 'Feature Planning', icon: CheckSquare },
          { label: 'Data Architecture', icon: Database },
          { label: 'Task Management', icon: CheckSquare }
        ]
      },
      draggable: false
    }
  ];

  // Simplified edges - now 7 total connections (solid lines)
  const initialEdges = [
    // IDEs to Archon (4 purple lines)
    { 
      id: 'cursor-archon', 
      source: 'cursor', 
      target: 'archon', 
      type: 'smoothstep',
      style: { 
        stroke: '#8b5cf6', 
        strokeWidth: 3
      }
    },
    { 
      id: 'claude-archon', 
      source: 'claude', 
      target: 'archon', 
      type: 'smoothstep',
      style: { 
        stroke: '#8b5cf6', 
        strokeWidth: 3
      }
    },
    { 
      id: 'windsurf-archon', 
      source: 'windsurf', 
      target: 'archon', 
      type: 'smoothstep',
      style: { 
        stroke: '#8b5cf6', 
        strokeWidth: 3
      }
    },
    { 
      id: 'vscode-archon', 
      source: 'vscode', 
      target: 'archon', 
      type: 'smoothstep',
      style: { 
        stroke: '#8b5cf6', 
        strokeWidth: 3
      }
    },
    
    // Archon to Archon UI (1 blue line)
    { 
      id: 'archon-ui', 
      source: 'archon', 
      sourceHandle: 'bottom',
      target: 'archon-ui', 
      type: 'smoothstep',
      style: { 
        stroke: '#3b82f6', 
        strokeWidth: 3
      }
    },
    
    // Archon to containers (2 lines)
    { 
      id: 'archon-knowledge', 
      source: 'archon', 
      sourceHandle: 'right',
      target: 'knowledge-sources', 
      type: 'smoothstep',
      style: { 
        stroke: '#10b981', 
        strokeWidth: 3
      }
    },
    { 
      id: 'archon-intelligence', 
      source: 'archon', 
      sourceHandle: 'right',
      target: 'project-intelligence', 
      type: 'smoothstep',
      style: { 
        stroke: '#f59e0b', 
        strokeWidth: 3
      }
    }
  ];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Custom node components
  const nodeTypes = {
    ide: ({ data }) => (
      <div className={styles.ideNode}>
        <img src={data.icon} alt={data.label} className={styles.nodeIcon} />
        <span className={styles.nodeLabel}>{data.label}</span>
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: '#8b5cf6', border: '2px solid #8b5cf6' }}
        />
      </div>
    ),
    archon: ({ data }) => (
      <div className={styles.archonNode}>
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          style={{ background: '#8b5cf6', border: '2px solid #8b5cf6' }}
        />
<img src="/img/Python-logo-notext.svg" alt="Python" className={styles.pythonIcon} />
        <img src="/logo-neon.png" alt="Archon" className={styles.archonIcon} />
        <div className={styles.archonText}>
          <h3>{data.label}</h3>
          <p>{data.subtitle}</p>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          style={{ background: '#10b981', border: '2px solid #10b981' }}
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          style={{ background: '#3b82f6', border: '2px solid #3b82f6' }}
        />
      </div>
    ),
    'ui-control': ({ data }) => (
      <div className={styles.uiControlNode}>
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: '#3b82f6', border: '2px solid #3b82f6' }}
        />
<img src="/img/React-icon.svg" alt="React" className={styles.reactIcon} />
        <h3 className={styles.uiControlTitle}>{data.title}</h3>
        <p className={styles.uiControlSubtitle}>{data.subtitle}</p>
      </div>
    ),
    mcp: ({ data }) => (
      <div className={styles.mcpNode}>
        <img src="/img/mcp.svg" alt="MCP" className={styles.mcpIcon} />
      </div>
    ),
    fastapi: ({ data }) => (
      <div className={styles.fastapiNode}>
        <img src="/img/fastapi-seeklogo.svg" alt="FastAPI" className={styles.fastapiIcon} />
      </div>
    ),
    container: ({ data }) => (
      <div className={styles.containerNode} data-type={data.type}>
        <h3 className={styles.containerTitle}>{data.title}</h3>
        <div className={styles.containerGrid}>
          {data.items.map((item, index) => (
            <div key={index} className={styles.containerItem}>
              <item.icon size={16} className={styles.itemIcon} />
              <span className={styles.itemLabel}>{item.label}</span>
            </div>
          ))}
        </div>
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: '#10b981', border: '2px solid #10b981' }}
        />
      </div>
    )
  };

  return (
    <div style={{ height: '450px', width: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
        minZoom={1}
        maxZoom={1}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        translateExtent={[
          [0, 0],
          [1000, 550],
        ]}
      />
    </div>
  );
};

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroContent}>
          <h1 className="hero__title">{siteConfig.title}</h1>
          <p className="hero__subtitle">Supercharge your AI development workflow. Plug Cursor, Windsurf, or any AI IDE into Archon to unlock instant access to your business knowledge, technical docs, project requirements, and development tasks.</p>
          <div className={styles.buttons}>
            <Link
              className="button button--green-neon button--lg"
              to="/getting-started">
              Get Started - Quick Setup ⚡
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

function HomepageContent() {
  const [lucideIcons, setLucideIcons] = useState(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    
    // Dynamically import Lucide React only on client side
    const loadLucideIcons = async () => {
      try {
        const { Database, Zap, Globe, FileText, CheckSquare, Plug } = await import('lucide-react');
        setLucideIcons({ Database, Zap, Globe, FileText, CheckSquare, Plug });
      } catch (error) {
        console.error('Error loading Lucide icons:', error);
      }
    };

    loadLucideIcons();
  }, []);

  if (!isClient || !lucideIcons) {
    return (
      <main>
        <section className={styles.features}>
          <div className="container">
            <h2 className="text--center margin-bottom--xl">✨ Key Features</h2>
            <div className="row">
              <div className="col col--12">
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', color: '#ffffff' }}>
                  Loading Features...
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const { Database, Zap, Globe, FileText, CheckSquare, Plug } = lucideIcons;

  const features = [
    {
      title: 'Knowledge Management',
      icon: Database,
      description: 'Intelligently crawl documentation sites, upload PDFs and documents, and organize knowledge by type (technical vs business). Advanced source filtering enables precise RAG queries across your entire knowledge base.'
    },
    {
      title: 'Advanced RAG Capabilities', 
      icon: Zap,
      description: 'Smart URL detection, contextual embeddings, hybrid search, and reranking deliver superior search results. Special handling for code snippets and technical documentation with AI-powered content understanding.'
    },
    {
      title: 'MCP Integration',
      icon: Plug,
      description: 'Universal compatibility with Cursor, Windsurf, Claude Desktop, and any MCP client. Dual transport support (SSE/stdio) with real-time access to your knowledge base directly from your AI coding assistants.'
    },
    {
      title: 'Document Processing',
      icon: FileText,
      description: 'Dual-engine PDF extraction, Word document support, markdown processing, and smart chunking. AI-generated metadata and automatic code example extraction for comprehensive document understanding.'
    },
    {
      title: 'Web Interface',
      icon: Globe,
      description: 'Complete web dashboard for MCP server management, document upload, crawling operations, and interactive knowledge chat. Real-time log streaming and progress tracking for all operations.'
    },
    {
      title: 'Task Management',
      icon: CheckSquare,
      description: 'Integrated project and task management with AI agent integration. Create, track, and organize development tasks with automatic linking to relevant documentation and code examples.'
    }
  ];

  return (
    <main>
      <section className={styles.features}>
        <div className="container">
          <h2 className="text--center margin-bottom--xl">✨ Key Features</h2>
          
          {/* First Row - 3 cards */}
          <div className="row">
            {features.slice(0, 3).map((feature, idx) => {
              const IconComponent = feature.icon;
              return (
                <div key={idx} className="col col--4">
                  <div className={styles.glassContainer}>
                    <div className={styles.featureHeader}>
                      <IconComponent 
                        size={36} 
                        className={styles.featureIcon}
                      />
                      <h3>{feature.title}</h3>
                    </div>
                    <p className={styles.featureDescription}>{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* Second Row - 3 cards */}
          <div className={`row ${styles.featureRowSpacing}`}>
            {features.slice(3, 6).map((feature, idx) => {
              const IconComponent = feature.icon;
              return (
                <div key={idx + 3} className="col col--4">
                  <div className={styles.glassContainer}>
                    <div className={styles.featureHeader}>
                      <IconComponent 
                        size={36} 
                        className={styles.featureIcon}
                      />
                      <h3>{feature.title}</h3>
                    </div>
                    <p className={styles.featureDescription}>{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className={styles.quickStart}>
        <div className="container">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <h2>🚀 Quick Start</h2>
              <p>Ready to get started? Follow our comprehensive setup guide:</p>
              <div className="text--center">
                <Link
                  className="button button--green-neon button--lg"
                  to="/getting-started">
                  👉 Getting Started Guide - Complete setup from installation to first knowledge base
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.nextSteps}>
        <div className="container">
          <div className="row">
            <div className="col col--8 col--offset-2">
              <h2>🎯 Next Steps</h2>
              <ol>
                <li><strong><Link to="/getting-started">Set up Archon</Link></strong> - Get your knowledge engine running</li>
                <li><strong><Link to="/mcp-overview">Connect your AI client</Link></strong> - Integrate with Cursor, Windsurf, or Claude Desktop</li>
                <li><strong><Link to="/getting-started#building-your-knowledge-base">Build your knowledge base</Link></strong> - Start crawling and uploading content</li>
                <li><strong><Link to="/rag">Optimize for your use case</Link></strong> - Configure RAG strategies</li>
                <li><strong><Link to="/deployment">Deploy to production</Link></strong> - Scale for team or enterprise use</li>
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.callToAction}>
        <div className="container">
          <div className="row">
            <div className="col col--8 col--offset-2 text--center">
              <hr />
              <p><strong>Archon</strong> - <em>Supercharging AI IDE's with knowledge and tasks</em></p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();

  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description="Description will go into a meta tag in <head />">
      <HomepageHeader />
      <main>
        {/* Architecture Diagram */}
        <section className={styles.architectureSection}>
          <ArchitectureDiagram />
        </section>

        <HomepageContent />
      </main>
    </Layout>
  );
}
