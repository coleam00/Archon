import { useCallback, useState, useEffect, useMemo } from 'react'
import '@xyflow/react/dist/style.css'
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  MarkerType,
  NodeProps,
  Handle,
  Position,
  NodeChange,
  applyNodeChanges,
  EdgeChange,
  applyEdgeChanges,
  Connection,
  addEdge,
} from '@xyflow/react'
import { Layout, Component as ComponentIcon, X, Trash2, Edit, Save } from 'lucide-react'
import { projectService } from '../../services/projectService'
import { useToast } from '../../contexts/ToastContext'

// Define custom node types following React Flow v12 pattern
type PageNodeData = {
  label: string;
  type: string;
  route: string;
  components: number;
};

type ServiceNodeData = {
  label: string;
  type: string;
};

// Define union type for all custom nodes
type CustomNodeTypes = Node<PageNodeData, 'page'> | Node<ServiceNodeData, 'service'>;

// Custom node components
const PageNode = ({ data }: NodeProps) => {
  const pageData = data as PageNodeData;
  return (
    <div className="relative group">
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 !bg-cyan-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(34,211,238,0.6)]"
      />
      <div className="p-4 rounded-lg bg-[#1a2c3b]/80 border border-cyan-500/30 min-w-[200px] backdrop-blur-sm transition-all duration-300 group-hover:border-cyan-500/70 group-hover:shadow-[0_5px_15px_rgba(34,211,238,0.15)]">
        <div className="flex items-center gap-2 mb-2">
          <Layout className="w-4 h-4 text-cyan-400" />
          <div className="text-sm font-bold text-cyan-400">{pageData.label}</div>
        </div>
        <div className="text-xs text-gray-400">{pageData.type}</div>
        <div className="mt-2 text-xs text-gray-500">
          <div>Route: {pageData.route}</div>
          <div>Components: {pageData.components}</div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 !bg-cyan-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(34,211,238,0.6)]"
      />
    </div>
  );
};

const ServiceNode = ({ data }: NodeProps) => {
  const serviceData = data as ServiceNodeData;
  return (
    <div className="relative group">
      <Handle
        type="target"
        position={Position.Top}
        className="w-3 h-3 !bg-fuchsia-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(217,70,239,0.6)]"
      />
      <div className="p-4 rounded-lg bg-[#2d1a3b]/80 border border-fuchsia-500/30 min-w-[200px] backdrop-blur-sm transition-all duration-300 group-hover:border-fuchsia-500/70 group-hover:shadow-[0_5px_15px_rgba(217,70,239,0.15)]">
        <div className="flex items-center gap-2 mb-2">
          <ComponentIcon className="w-4 h-4 text-fuchsia-400" />
          <div className="text-sm font-bold text-fuchsia-400">{serviceData.label}</div>
        </div>
        <div className="text-xs text-gray-400">{serviceData.type}</div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="w-3 h-3 !bg-fuchsia-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(217,70,239,0.6)]"
      />
    </div>
  );
};

const nodeTypes = {
  page: PageNode,
  service: ServiceNode,
}

// Default/fallback nodes for when project has no features data
const defaultNodes: Node[] = [
  {
    id: 'start',
    type: 'page',
    data: {
      label: 'Start App',
      type: 'Entry Point',
      route: '/',
      components: 3,
    },
    position: {
      x: 400,
      y: 0,
    },
  },
  {
    id: 'home',
    type: 'page',
    data: {
      label: 'Homepage',
      type: 'Main View',
      route: '/home',
      components: 6,
    },
    position: {
      x: 400,
      y: 150,
    },
  },
];

// Default/fallback edges
const defaultEdges: Edge[] = [
  {
    id: 'start-home',
    source: 'start',
    target: 'home',
    animated: true,
    style: {
      stroke: '#22d3ee',
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: '#22d3ee',
    },
  },
];

interface FeaturesTabProps {
  project?: {
    id: string;
    title: string;
    features?: import('../types/jsonb').ProjectFeature[];
  } | null;
}

export const FeaturesTab = ({ project }: FeaturesTabProps) => {
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [loading, setLoading] = useState(true)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<string | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [editingNode, setEditingNode] = useState<Node | null>(null)
  const [showEditModal, setShowEditModal] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const { showToast } = useToast()

  // Load features from project or show empty state
  useEffect(() => {
    if (project?.features && Array.isArray(project.features) && project.features.length > 0) {
      // Ensure all nodes have required properties with defaults
      const normalizedNodes = project.features.map((node: any, index: number) => ({
        ...node,
        // Ensure position exists with sensible defaults
        position: node.position || {
          x: 250 + (index % 3) * 250, // Spread horizontally
          y: 200 + Math.floor(index / 3) * 150 // Stack vertically
        },
        // Ensure type exists (fallback based on data structure)
        type: node.type || (node.data?.route ? 'page' : 'service'),
        // Ensure data exists
        data: node.data || { label: 'Unknown', type: 'Unknown Component' }
      }));
      
      setNodes(normalizedNodes)
      // Generate edges based on the flow (simplified logic)
      const generatedEdges = generateEdgesFromNodes(normalizedNodes)
      setEdges(generatedEdges)
    } else {
      // Show empty state - no nodes or edges
      setNodes([])
      setEdges([])
    }
    setLoading(false)
  }, [project])

  // Helper function to generate edges based on node positioning and types
  const generateEdgesFromNodes = (nodes: Node[]): Edge[] => {
    const edges: Edge[] = []
    
    // Sort nodes by y position to create a logical flow (with safety check for position)
    const sortedNodes = [...nodes].sort((a, b) => {
      const aY = a.position?.y || 0;
      const bY = b.position?.y || 0;
      return aY - bY;
    })
    
    for (let i = 0; i < sortedNodes.length - 1; i++) {
      const currentNode = sortedNodes[i]
      const nextNode = sortedNodes[i + 1]
      
      // Connect sequential nodes with appropriate styling
      const edgeStyle = currentNode.type === 'service' ? '#d946ef' : '#22d3ee'
      
      edges.push({
        id: `${currentNode.id}-${nextNode.id}`,
        source: currentNode.id,
        target: nextNode.id,
        animated: true,
        style: {
          stroke: edgeStyle,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeStyle,
        },
      })
    }
    
    return edges
  }

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds))
      setHasUnsavedChanges(true)
    },
    [],
  )
  
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds))
      setHasUnsavedChanges(true)
    },
    [],
  )
  
  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((node) => node.id === connection.source)
      // Set edge color based on source node type
      const edgeStyle =
        sourceNode?.type === 'service'
          ? {
              stroke: '#d946ef',
            }
          : // Fuchsia for service nodes
            {
              stroke: '#22d3ee',
            } // Cyan for page nodes
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            animated: true,
            style: edgeStyle,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: edgeStyle.stroke,
            },
          },
          eds,
        ),
      )
      setHasUnsavedChanges(true)
    },
    [nodes],
  )

  const saveToDatabase = async (nodesToSave = nodes, edgesToSave = edges) => {
    if (!project?.id) {
      console.error('❌ No project ID available for saving features');
      return;
    }

    setIsSaving(true);
    try {
      console.log('💾 Saving features to database...');
      await projectService.updateProject(project.id, {
        features: nodesToSave
      });
      console.log('✅ Features saved successfully');
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('❌ Failed to save features:', error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualSave = async () => {
    await saveToDatabase();
  };

  const addPageNode = async () => {
    const newNode: Node = {
      id: `page-${Date.now()}`,
      type: 'page',
      data: {
        label: `New Page`,
        type: 'Page Component',
        route: '/new-page',
        components: 0,
      },
      position: {
        x: 250,
        y: 200,
      },
    }
    const newNodes = [...nodes, newNode];
    setNodes(newNodes);
    setHasUnsavedChanges(true);
    
    // Auto-save when adding
    try {
      await saveToDatabase(newNodes, edges);
    } catch (error) {
      // Revert on error
      setNodes(nodes);
    }
  }

  const addServiceNode = async () => {
    const newNode: Node = {
      id: `service-${Date.now()}`,
      type: 'service',
      data: {
        label: 'New Service',
        type: 'Service Component',
      },
      position: {
        x: 250,
        y: 200,
      },
    }
    const newNodes = [...nodes, newNode];
    setNodes(newNodes);
    setHasUnsavedChanges(true);
    
    // Auto-save when adding
    try {
      await saveToDatabase(newNodes, edges);
    } catch (error) {
      // Revert on error
      setNodes(nodes);
    }
  }

  const handleDeleteNode = useCallback(async (event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation();
    
    if (!project?.id) {
      console.error('❌ No project ID available for deleting node');
      return;
    }

    // Show custom confirmation dialog
    setNodeToDelete(nodeId);
    setShowDeleteConfirm(true);
  }, [project?.id]);

  const confirmDelete = useCallback(async () => {
    if (!nodeToDelete) return;

    console.log('🗑️ Deleting node:', nodeToDelete);

    try {
      // Remove node from UI
      const newNodes = nodes.filter(node => node.id !== nodeToDelete);
      
      // Remove any edges connected to this node
      const newEdges = edges.filter(edge => 
        edge.source !== nodeToDelete && edge.target !== nodeToDelete
      );
      
      setNodes(newNodes);
      setEdges(newEdges);

      // Save to database
      await saveToDatabase(newNodes, newEdges);
      showToast('Node deleted successfully', 'success');
      
      // Close confirmation dialog
      setShowDeleteConfirm(false);
      setNodeToDelete(null);
    } catch (error) {
      console.error('❌ Failed to delete node:', error);
      // Revert UI changes on error
      setNodes(nodes);
      setEdges(edges);
      showToast('Failed to delete node', 'error');
    }
  }, [nodeToDelete, nodes, edges]);

    const cancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
    setNodeToDelete(null);
  }, []);

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setEditingNode(node);
    setShowEditModal(true);
  }, []);

  const saveNodeChanges = async (updatedNode: Node) => {
    // Update local state first
    const newNodes = nodes.map(node => 
      node.id === updatedNode.id ? updatedNode : node
    );
    setNodes(newNodes);

    // Save to database
    await saveToDatabase(newNodes, edges);
    
    setShowEditModal(false);
    setEditingNode(null);
  };

  // Memoize node types with delete and edit functionality
  const nodeTypes = useMemo(() => ({
    page: ({ data, id }: NodeProps) => {
      const pageData = data as any;
      return (
        <div className="relative group">
          <Handle
            type="target"
            position={Position.Top}
            className="w-3 h-3 !bg-cyan-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(34,211,238,0.6)]"
          />
          <div 
            className="p-4 rounded-lg bg-[#1a2c3b]/80 border border-cyan-500/30 min-w-[200px] backdrop-blur-sm transition-all duration-300 group-hover:border-cyan-500/70 group-hover:shadow-[0_5px_15px_rgba(34,211,238,0.15)] cursor-pointer"
            onClick={(e) => {
              const actualNode = nodes.find(node => node.id === id);
              if (actualNode) {
                handleNodeClick(e, actualNode);
              }
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <Layout className="w-4 h-4 text-cyan-400" />
                <div className="text-sm font-bold text-cyan-400">{pageData.label}</div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const actualNode = nodes.find(node => node.id === id);
                    if (actualNode) {
                      handleNodeClick(e, actualNode);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-cyan-600/20 rounded"
                  title="Edit node"
                >
                  <Edit className="w-3 h-3 text-cyan-400 hover:text-cyan-300" />
                </button>
                <button
                  onClick={(e) => handleDeleteNode(e, id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-600/20 rounded"
                  title="Delete node"
                >
                  <Trash2 className="w-3 h-3 text-red-400 hover:text-red-300" />
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-400">{pageData.type}</div>
            <div className="mt-2 text-xs text-gray-500">
              <div>Route: {pageData.route}</div>
              <div>Components: {pageData.components}</div>
            </div>
          </div>
          <Handle
            type="source"
            position={Position.Bottom}
            className="w-3 h-3 !bg-cyan-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(34,211,238,0.6)]"
          />
        </div>
      );
    },
    service: ({ data, id }: NodeProps) => {
      const serviceData = data as any;
      return (
        <div className="relative group">
          <Handle
            type="target"
            position={Position.Top}
            className="w-3 h-3 !bg-fuchsia-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(217,70,239,0.6)]"
          />
          <div 
            className="p-4 rounded-lg bg-[#2d1a3b]/80 border border-fuchsia-500/30 min-w-[200px] backdrop-blur-sm transition-all duration-300 group-hover:border-fuchsia-500/70 group-hover:shadow-[0_5px_15px_rgba(217,70,239,0.15)] cursor-pointer"
            onClick={(e) => {
              const actualNode = nodes.find(node => node.id === id);
              if (actualNode) {
                handleNodeClick(e, actualNode);
              }
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <ComponentIcon className="w-4 h-4 text-fuchsia-400" />
                <div className="text-sm font-bold text-fuchsia-400">{serviceData.label}</div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const actualNode = nodes.find(node => node.id === id);
                    if (actualNode) {
                      handleNodeClick(e, actualNode);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-fuchsia-600/20 rounded"
                  title="Edit node"
                >
                  <Edit className="w-3 h-3 text-fuchsia-400 hover:text-fuchsia-300" />
                </button>
                <button
                  onClick={(e) => handleDeleteNode(e, id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-600/20 rounded"
                  title="Delete node"
                >
                  <Trash2 className="w-3 h-3 text-red-400 hover:text-red-300" />
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-400">{serviceData.type}</div>
          </div>
          <Handle
            type="source"
            position={Position.Bottom}
            className="w-3 h-3 !bg-fuchsia-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(217,70,239,0.6)]"
          />
        </div>
      );
    }
  }), [handleNodeClick, handleDeleteNode, nodes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading features...</div>
      </div>
    )
  }

  return (
    <div className="relative pt-8">
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(0,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,255,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px]" />
      <div className="relative z-10">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg text-cyan-400 font-mono flex items-center">
            <span className="w-2 h-2 rounded-full bg-cyan-400 mr-2 shadow-[0_0_8px_rgba(34,211,238,0.6)]"></span>
            Feature Planner {project?.features ? `(${project.features.length} features)` : '(Default)'}
          </div>
          <div className="flex gap-2">
            {hasUnsavedChanges && (
              <button 
                onClick={handleManualSave}
                disabled={isSaving}
                className="px-3 py-1.5 rounded-lg bg-green-900/20 border border-green-500/30 text-green-400 hover:bg-green-900/30 hover:border-green-500/50 transition-all duration-300 text-xs flex items-center gap-2"
              >
                <Save className="w-3 h-3" />
                {isSaving ? 'Saving...' : 'Save Layout'}
              </button>
            )}
            <button
              onClick={addPageNode}
              className="px-3 py-1.5 rounded-lg bg-cyan-900/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-900/30 hover:border-cyan-500/50 hover:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 flex items-center gap-2 relative overflow-hidden group"
            >
              <span className="absolute inset-0 bg-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity"></span>
              <Layout className="w-4 h-4 relative z-10" />
              <span className="text-xs relative z-10">Add Page</span>
            </button>
            <button
              onClick={addServiceNode}
              className="px-3 py-1.5 rounded-lg bg-fuchsia-900/20 border border-fuchsia-500/30 text-fuchsia-400 hover:bg-fuchsia-900/30 hover:border-fuchsia-500/50 hover:shadow-[0_0_15px_rgba(217,70,239,0.3)] transition-all duration-300 flex items-center gap-2 relative overflow-hidden group"
            >
              <span className="absolute inset-0 bg-fuchsia-500/10 opacity-0 group-hover:opacity-100 transition-opacity"></span>
              <ComponentIcon className="w-4 h-4 relative z-10" />
              <span className="text-xs relative z-10">Add Service</span>
            </button>
          </div>
        </div>
        <div className="h-[70vh] relative">
          {/* Subtle neon glow at the top */}
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-cyan-500/30 shadow-[0_0_10px_rgba(34,211,238,0.2)] z-10"></div>
          {nodes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <Layout className="w-16 h-16 mb-4 opacity-50" />
              <p className="text-lg mb-2">No features defined</p>
              <p className="text-sm">Add pages and services to get started</p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              attributionPosition="bottom-right"
            >
              <Controls className="!bg-white/70 dark:!bg-black/70 !border-gray-300 dark:!border-gray-800" />
            </ReactFlow>
          )}
        </div>

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <DeleteConfirmModal
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
            nodeName={nodes.find(n => n.id === nodeToDelete)?.data.label as string || 'node'}
          />
        )}

        {/* Edit Modal */}
        {showEditModal && editingNode && (
          <EditFeatureModal
            node={editingNode}
            onSave={saveNodeChanges}
            onClose={() => {
              setShowEditModal(false);
              setEditingNode(null);
            }}
          />
        )}
      </div>
    </div>
  )
}

// Delete Confirmation Modal Component
const DeleteConfirmModal = ({ 
  onConfirm, 
  onCancel, 
  nodeName 
}: { 
  onConfirm: () => void; 
  onCancel: () => void; 
  nodeName: string;
}) => {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-red-500 
          before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]">
        
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                Delete Node
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>
          
          <p className="text-gray-700 dark:text-gray-300 mb-6">
            Are you sure you want to delete <span className="font-medium text-red-600 dark:text-red-400">"{nodeName}"</span>? 
            This will also remove all related connections.
          </p>
          
          <div className="flex justify-end gap-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors shadow-lg shadow-red-600/25 hover:shadow-red-700/25"
            >
              Delete Node
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Edit Feature Modal Component
const EditFeatureModal = ({ 
  node, 
  onSave, 
  onClose 
}: { 
  node: Node; 
  onSave: (node: Node) => void; 
  onClose: () => void; 
}) => {
  const [name, setName] = useState(node.data.label as string);
  const [route, setRoute] = useState((node.data as any).route || '');
  const [components, setComponents] = useState((node.data as any).components || 0);

  const isPageNode = node.type === 'page';

  const handleSave = () => {
    const updatedNode = {
      ...node,
      data: {
        ...node.data,
        label: name,
        ...(isPageNode && { route, components })
      }
    };
    onSave(updatedNode);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-cyan-500/30 rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-cyan-400 flex items-center gap-2">
            {isPageNode ? <Layout className="w-5 h-5" /> : <ComponentIcon className="w-5 h-5" />}
            Edit {isPageNode ? 'Page' : 'Service'}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {isPageNode ? 'Page' : 'Service'} Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none"
            />
          </div>

          {isPageNode && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Route
                </label>
                <input
                  type="text"
                  value={route}
                  onChange={(e) => setRoute(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none"
                  placeholder="/example-page"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Components Count
                </label>
                <input
                  type="number"
                  value={components}
                  onChange={(e) => setComponents(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none"
                  min="0"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg transition-colors shadow-lg shadow-cyan-600/25 hover:shadow-cyan-700/25 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
