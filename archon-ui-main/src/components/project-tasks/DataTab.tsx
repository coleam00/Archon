import React, { useCallback, useState, useEffect, useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { ReactFlow, Node, Edge, Background, Controls, MarkerType, NodeChange, applyNodeChanges, EdgeChange, applyEdgeChanges, ConnectionLineType, addEdge, Connection, Handle, Position } from '@xyflow/react';
import { Database, Info, Calendar, TrendingUp, Edit, Plus, X, Save, Trash2 } from 'lucide-react';
import { projectService } from '../../services/projectService';
import { useToast } from '../../contexts/ToastContext';

// Custom node types - will be defined inside the component to access state

const createTableNode = (id: string, label: string, columns: string[], x: number, y: number): Node => ({
  id,
  type: 'table',
  data: {
    label,
    columns
  },
  position: {
    x,
    y
  }
});

// Default fallback nodes for basic database structure
const defaultNodes: Node[] = [
  createTableNode('users', 'Users', ['id (PK) - UUID', 'email - VARCHAR(255)', 'password - VARCHAR(255)', 'firstName - VARCHAR(100)', 'lastName - VARCHAR(100)', 'createdAt - TIMESTAMP', 'updatedAt - TIMESTAMP'], 150, 100),
  createTableNode('projects', 'Projects', ['id (PK) - UUID', 'title - VARCHAR(255)', 'description - TEXT', 'status - VARCHAR(50)', 'userId (FK) - UUID', 'createdAt - TIMESTAMP', 'updatedAt - TIMESTAMP'], 500, 100)
];

const defaultEdges: Edge[] = [{
  id: 'projects-users',
  source: 'users',
  target: 'projects',
  sourceHandle: 'Users-id',
  targetHandle: 'Projects-userId',
  animated: true,
  style: {
    stroke: '#d946ef'
  },
  markerEnd: {
    type: MarkerType.Arrow,
    color: '#d946ef'
  }
}];

// Data metadata card component for the new data structure
const DataCard = ({ data }: { data: any }) => {
  const iconMap: { [key: string]: any } = {
    'ShoppingCart': Database,
    'Database': Database,
    'Info': Info,
    'Calendar': Calendar,
    'TrendingUp': TrendingUp
  };
  
  const IconComponent = iconMap[data.icon] || Database;
  
  const colorClasses = {
    cyan: 'from-cyan-900/40 to-cyan-800/30 border-cyan-500/50 text-cyan-400',
    blue: 'from-blue-900/40 to-blue-800/30 border-blue-500/50 text-blue-400',
    purple: 'from-purple-900/40 to-purple-800/30 border-purple-500/50 text-purple-400',
    pink: 'from-pink-900/40 to-pink-800/30 border-pink-500/50 text-pink-400'
  };
  
  const colorClass = colorClasses[data.color as keyof typeof colorClasses] || colorClasses.cyan;
  
  return (
    <div className={`p-6 rounded-lg bg-gradient-to-r ${colorClass} backdrop-blur-md border min-w-[300px] transition-all duration-300 hover:shadow-[0_0_15px_rgba(34,211,238,0.2)] group`}>
      <div className="flex items-center gap-3 mb-4">
        <IconComponent className="w-6 h-6" />
        <div className="text-lg font-bold">Project Data Overview</div>
      </div>
      <div className="space-y-3">
        <div className="text-sm opacity-90">
          <div className="font-medium mb-1">Description:</div>
          <div className="text-xs opacity-80">{data.description}</div>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="opacity-90">Progress:</span>
          <div className="flex items-center gap-2">
            <div className="w-20 h-2 bg-black/30 rounded-full overflow-hidden">
              <div 
                className="h-full bg-current rounded-full transition-all duration-300"
                style={{ width: `${data.progress}%` }}
              />
            </div>
            <span className="text-xs font-medium">{data.progress}%</span>
          </div>
        </div>
        <div className="text-xs opacity-75">
          Last updated: {data.updated}
        </div>
      </div>
    </div>
  );
};

interface DataTabProps {
  project?: {
    id: string;
    title: string;
    data?: any[];
  } | null;
}

export const DataTab = ({ project }: DataTabProps) => {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'metadata' | 'erd'>('metadata');
  const [editingNode, setEditingNode] = useState<Node | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [nodeToDelete, setNodeToDelete] = useState<string | null>(null);

  const { showToast } = useToast();


  // Helper function to normalize nodes to ensure required properties
  const normalizeNode = (node: any): Node => {
    return {
      id: node.id || `node-${Date.now()}-${Math.random()}`,
      type: node.type || 'table',
      position: {
        x: node.position?.x || 100,
        y: node.position?.y || 100
      },
      data: {
        label: node.data?.label || 'Untitled',
        columns: node.data?.columns || ['id (PK) - UUID']
      }
    };
  };

  useEffect(() => {
    console.log('DataTab project data:', project?.data);
    
    // Determine view mode based on data structure
    if (project?.data) {
      if (Array.isArray(project.data) && project.data.length > 0) {
        // Handle array format: [{"type": "erd", ...}] or [{"description": "...", "progress": 65}]
        const firstItem = project.data[0];
        console.log('First data item (array):', firstItem);
        
        if (firstItem.description && typeof firstItem.progress === 'number') {
          console.log('Setting metadata view');
          setViewMode('metadata');
        } else if (firstItem.type === 'erd' && firstItem.nodes && firstItem.edges) {
          console.log('Setting ERD view with structured array data');
          setViewMode('erd');
          // Normalize nodes to ensure required properties
          const normalizedNodes = firstItem.nodes.map(normalizeNode);
          setNodes(normalizedNodes);
          // Fix any ArrowClosed marker types in loaded edges
          const sanitizedEdges = firstItem.edges.map((edge: any) => ({
            ...edge,
            markerEnd: edge.markerEnd ? {
              ...edge.markerEnd,
              type: edge.markerEnd.type === 'ArrowClosed' ? MarkerType.Arrow : edge.markerEnd.type
            } : undefined
          }));
          setEdges(sanitizedEdges);
        } else {
          console.log('Setting ERD view for array data');
          setViewMode('erd');
          // Normalize nodes to ensure required properties
          const normalizedNodes = project.data.map(normalizeNode);
          setNodes(normalizedNodes);
          setEdges([]);
        }
      } else if (typeof project.data === 'object' && !Array.isArray(project.data) && 
                 (project.data as any).type === 'erd' && 
                 (project.data as any).nodes && 
                 (project.data as any).edges) {
        // Handle direct object format: {"type": "erd", "nodes": [...], "edges": [...]}
        console.log('Setting ERD view with direct object data');
        setViewMode('erd');
        // Normalize nodes to ensure required properties
        const normalizedNodes = (project.data as any).nodes.map(normalizeNode);
        setNodes(normalizedNodes);
        // Fix any ArrowClosed marker types in loaded edges
        const sanitizedEdges = (project.data as any).edges.map((edge: any) => ({
          ...edge,
          markerEnd: edge.markerEnd ? {
            ...edge.markerEnd,
            type: edge.markerEnd.type === 'ArrowClosed' ? MarkerType.Arrow : edge.markerEnd.type
          } : undefined
        }));
        setEdges(sanitizedEdges);
      } else {
        console.log('Unknown data format, showing empty state');
        setViewMode('erd');
        setNodes([]);
        setEdges([]);
      }
    } else {
      console.log('No data, using empty state');
      setViewMode('erd');
      setNodes([]);
      setEdges([]);
    }
    setLoading(false);
  }, [project]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(nds => applyNodeChanges(changes, nds));
    setHasUnsavedChanges(true);
  }, []);
  
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(eds => applyEdgeChanges(changes, eds));
    setHasUnsavedChanges(true);
  }, []);
  const onConnect = useCallback(async (connection: Connection) => {
    const newEdgeProps = {
      animated: true,
      style: {
        stroke: '#22d3ee'
      },
      markerEnd: {
        type: MarkerType.Arrow,
        color: '#22d3ee'
      },
      label: 'relates to',
      labelStyle: {
        fill: '#e94560',
        fontWeight: 500
      },
      labelBgStyle: {
        fill: 'rgba(0, 0, 0, 0.7)'
      }
    };

    const newEdges = addEdge({ ...connection, ...newEdgeProps }, edges);
    setEdges(newEdges);

    // Auto-save to database
    await saveToDatabase(nodes, newEdges);
  }, [nodes, edges, project?.id]);

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setEditingNode(node);
    setShowEditModal(true);
  }, []);



  const addTableNode = async () => {
    if (!project?.id) {
      console.error('❌ No project ID available for adding table');
      return;
    }

    console.log('🔄 Adding new table...');
    const newNodeId = `table-${Date.now()}`;
    const newNode = createTableNode(newNodeId, `New Table ${nodes.length + 1}`, ['id (PK) - UUID', 'name - VARCHAR(255)', 'description - TEXT', 'createdAt - TIMESTAMP', 'updatedAt - TIMESTAMP'], 400, 300);
    const newNodes = [...nodes, newNode];
    setNodes(newNodes);

    // Auto-save to database
    try {
      console.log('💾 Saving new table to database...');
      await saveToDatabase(newNodes, edges);
      console.log('✅ New table saved successfully');
    } catch (error) {
      console.error('❌ Failed to save new table:', error);
      // Optionally revert the UI change if save failed
      setNodes(nodes);
    }
  };

  const saveToDatabase = async (nodesToSave = nodes, edgesToSave = edges) => {
    if (!project?.id) {
      console.error('No project ID available for saving');
      return;
    }

    console.log('💾 saveToDatabase called with:', {
      projectId: project.id,
      nodeCount: nodesToSave.length,
      edgeCount: edgesToSave.length
    });

    setIsSaving(true);
    try {
      const updatedData = {
        type: 'erd',
        nodes: nodesToSave,
        edges: edgesToSave
      };

      console.log('🔄 Calling projectService.updateProject with data:', updatedData);

      const result = await projectService.updateProject(project.id, {
        data: [updatedData] // Wrap in array to match UpdateProjectRequest type
      });

      console.log('✅ ERD data saved successfully, result:', result);
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('❌ Failed to save ERD data:', error);
      console.error('Error details:', error);
      throw error; // Re-throw so calling function can handle it
    } finally {
      setIsSaving(false);
    }
  };

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

  const handleManualSave = async () => {
    await saveToDatabase();
  };

  const handleDeleteNode = useCallback(async (event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation(); // Prevent triggering the edit modal
    
    if (!project?.id) {
      console.error('❌ No project ID available for deleting table');
      return;
    }

    // Show custom confirmation dialog
    setNodeToDelete(nodeId);
    setShowDeleteConfirm(true);
  }, [project?.id]);

  const confirmDelete = useCallback(async () => {
    if (!nodeToDelete) return;

    console.log('🗑️ Deleting table:', nodeToDelete);

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
      console.log('💾 Saving after table deletion...');
      await saveToDatabase(newNodes, newEdges);
      console.log('✅ Table deleted successfully');
      showToast('Table deleted successfully', 'success');
      
      // Close confirmation dialog
      setShowDeleteConfirm(false);
      setNodeToDelete(null);
    } catch (error) {
      console.error('❌ Failed to delete table:', error);
      // Revert UI changes on error
      setNodes(nodes);
      setEdges(edges);
      showToast('Failed to delete table', 'error');
    }
  }, [nodeToDelete, nodes, edges, saveToDatabase]);

  const cancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
    setNodeToDelete(null);
  }, []);

  // Memoize nodeTypes to prevent recreation on every render
  const nodeTypes = useMemo(() => ({
    table: ({ data, id }: any) => (
      <div 
        className="p-3 rounded-lg bg-gradient-to-r from-cyan-900/40 to-cyan-800/30 backdrop-blur-md border border-cyan-500/50 min-w-[220px] transition-all duration-300 hover:border-cyan-500/70 hover:shadow-[0_0_15px_rgba(34,211,238,0.2)] group"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan-400" />
            <div className="text-sm font-bold text-white border-b border-gray-600 pb-2">
              {data.label}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => handleDeleteNode(e, id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-600/20 rounded"
              title="Delete table"
            >
              <Trash2 className="w-3 h-3 text-red-400 hover:text-red-300" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Find the actual node from the nodes array instead of creating a fake one
                const actualNode = nodes.find(node => node.id === id);
                if (actualNode) {
                  handleNodeClick(e, actualNode);
                }
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-cyan-600/20 rounded"
              title="Edit table"
            >
              <Edit className="w-3 h-3 text-cyan-400 hover:text-cyan-300" />
            </button>
          </div>
        </div>
        <div className="text-xs text-left text-cyan-600">
          {data.columns.map((col: string, i: number) => {
            const isPK = col.includes('PK');
            const isFK = col.includes('FK');
            return (
              <div key={i} className={`py-1 relative ${isPK ? 'text-cyan-400 font-bold' : ''} ${isFK ? 'text-fuchsia-400 italic' : ''}`}>
                {col}
                {isPK && (
                  <Handle 
                    type="source" 
                    position={Position.Right} 
                    id={`${data.label}-${col.split(' ')[0]}`} 
                    className="w-2 h-2 !bg-cyan-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(34,211,238,0.6)]" 
                    style={{ right: -10 }} 
                  />
                )}
                {isFK && (
                  <Handle 
                    type="target" 
                    position={Position.Left} 
                    id={`${data.label}-${col.split(' ')[0]}`} 
                    className="w-2 h-2 !bg-fuchsia-400 transition-all duration-300 !opacity-60 group-hover:!opacity-100 group-hover:!shadow-[0_0_8px_rgba(217,70,239,0.6)]" 
                    style={{ left: -10 }} 
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    )
  }), [handleNodeClick, handleDeleteNode, nodes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading data...</div>
      </div>
    );
  }

  return (
    <div className="relative pt-8">
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(0,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,255,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
      <div className="relative z-10">
        <div className="flex justify-between items-center mb-4">
          <div className="text-lg text-cyan-400 font-mono flex items-center">
            <span className="w-2 h-2 rounded-full bg-cyan-400 mr-2 shadow-[0_0_8px_rgba(34,211,238,0.6)]"></span>
            {viewMode === 'metadata' ? 'Data Overview' : 'Data Relationships'}
            {viewMode === 'erd' && nodes.length > 0 && ` (${nodes.length} tables)`}
            {viewMode === 'metadata' && Array.isArray(project?.data) && ` (${project.data.length} items)`}
          </div>
          {viewMode === 'metadata' && (
            <button 
              onClick={() => setViewMode('erd')}
              className="px-3 py-1.5 rounded-lg bg-cyan-900/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-900/30 hover:border-cyan-500/50 transition-all duration-300 text-xs"
            >
              Switch to ERD
            </button>
          )}
          {viewMode === 'erd' && (
            <div className="flex gap-2">
              <button 
                onClick={() => setViewMode('metadata')}
                className="px-3 py-1.5 rounded-lg bg-purple-900/20 border border-purple-500/30 text-purple-400 hover:bg-purple-900/30 hover:border-purple-500/50 transition-all duration-300 text-xs"
              >
                Data Overview
              </button>
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
              <button onClick={addTableNode} className="p-2 rounded-lg bg-cyan-900/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-900/30 hover:border-cyan-500/50 hover:shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-all duration-300 flex items-center justify-center gap-2 w-full md:w-auto relative overflow-hidden group">
                <span className="absolute inset-0 bg-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity"></span>
                <Database className="w-4 h-4 relative z-10" />
                <span className="text-xs relative z-10">Add Table</span>
              </button>
            </div>
          )}
        </div>

        {viewMode === 'metadata' ? (
          <div className="space-y-6">
            {Array.isArray(project?.data) && project.data.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {project.data.map((item, index) => (
                  <DataCard key={index} data={item} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                <Info className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-lg mb-2">No metadata available</p>
                <p className="text-sm">Switch to ERD view to see database schema</p>
              </div>
            )}
          </div>
        ) : (
          <div className="h-[70vh] relative">
            {/* Subtle neon glow at the top */}
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-cyan-500/30 shadow-[0_0_10px_rgba(34,211,238,0.2)] z-10"></div>
            {nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                <Database className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-lg mb-2">No data schema defined</p>
                <p className="text-sm">Add tables to design your database</p>
              </div>
            ) : (
              <ReactFlow 
                nodes={nodes} 
                edges={edges} 
                onNodesChange={onNodesChange} 
                onEdgesChange={onEdgesChange} 
                onConnect={onConnect} 
                nodeTypes={nodeTypes} 
                connectionLineType={ConnectionLineType.Step} 
                defaultEdgeOptions={{
                  type: 'step',
                  style: {
                    stroke: '#d946ef'
                  },
                  animated: true,
                  markerEnd: {
                    type: MarkerType.Arrow,
                    color: '#d946ef'
                  }
                }} 
                fitView
              >
                <Controls className="!bg-white/70 dark:!bg-black/70 !border-gray-300 dark:!border-gray-800" />
              </ReactFlow>
            )}
          </div>
                )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
          <DeleteConfirmModal
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
            tableName={nodes.find(n => n.id === nodeToDelete)?.data.label as string || 'table'}
          />
        )}

        {/* Edit Modal */}
        {showEditModal && editingNode && (
          <EditTableModal
            node={editingNode}
            nodes={nodes}
            edges={edges}
            onSave={saveNodeChanges}
            onUpdateEdges={setEdges}
            onClose={() => {
              setShowEditModal(false);
              setEditingNode(null);
            }}
          />
        )}
      </div>
    </div>
  );
};

// Delete Confirmation Modal Component
const DeleteConfirmModal = ({ 
  onConfirm, 
  onCancel, 
  tableName 
}: { 
  onConfirm: () => void; 
  onCancel: () => void; 
  tableName: string;
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
                Delete Table
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>
          
          <p className="text-gray-700 dark:text-gray-300 mb-6">
            Are you sure you want to delete the <span className="font-medium text-red-600 dark:text-red-400">"{tableName}"</span> table? 
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
              Delete Table
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Column interface for better type management
interface ColumnDefinition {
  name: string;
  dataType: string;
  columnType: 'regular' | 'pk' | 'fk';
  referencedTable?: string;
  referencedColumn?: string;
}

// Edit Table Modal Component
const EditTableModal = ({ 
  node, 
  nodes,
  edges,
  onSave, 
  onUpdateEdges,
  onClose 
}: { 
  node: Node; 
  nodes: Node[];
  edges: Edge[];
  onSave: (node: Node) => void; 
  onUpdateEdges: (edges: Edge[]) => void;
  onClose: () => void; 
}) => {
  const [tableName, setTableName] = useState(node.data.label as string);
  const [columns, setColumns] = useState<ColumnDefinition[]>([]);

  // Parse existing columns into structured format
  useEffect(() => {
    const parsedColumns = (node.data.columns as string[]).map((colStr: string) => {
      const parts = colStr.split(' - ');
      const nameAndType = parts[0];
      const dataType = parts[1] || 'VARCHAR(255)';
      
      let columnType: 'regular' | 'pk' | 'fk' = 'regular';
      let name = nameAndType;
      const referencedTable = '';
      const referencedColumn = '';
      
      if (nameAndType.includes('(PK)')) {
        columnType = 'pk';
        name = nameAndType.replace(' (PK)', '');
      } else if (nameAndType.includes('(FK)')) {
        columnType = 'fk';
        name = nameAndType.replace(' (FK)', '');
      }
      
      return {
        name,
        dataType,
        columnType,
        referencedTable,
        referencedColumn
      };
    });
    setColumns(parsedColumns);
  }, [node.data.columns]);

  const addColumn = () => {
    setColumns([...columns, {
      name: 'newColumn',
      dataType: 'VARCHAR(255)',
      columnType: 'regular',
      referencedTable: '',
      referencedColumn: ''
    }]);
  };

  const updateColumn = (index: number, field: keyof ColumnDefinition, value: string) => {
    const newColumns = [...columns];
    newColumns[index] = { ...newColumns[index], [field]: value };
    setColumns(newColumns);
  };

  const removeColumn = (index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  };

  // Get available tables for FK references (exclude current table)
  const getAvailableTables = () => {
    return nodes.filter(n => n.id !== node.id).map(n => ({
      id: n.id,
      label: n.data.label as string
    }));
  };

  // Get available columns for a specific table
  const getAvailableColumns = (tableId: string) => {
    const targetNode = nodes.find(n => n.id === tableId);
    if (!targetNode) return [];
    
    return (targetNode.data.columns as string[])
      .filter(col => col.includes('(PK)')) // Only allow referencing primary keys
      .map(col => {
        const name = col.split(' - ')[0].replace(' (PK)', '');
        return { name, label: name };
      });
  };

  const handleSave = () => {
    // Convert columns back to string format
    const columnStrings = columns.map(col => {
      let name = col.name;
      if (col.columnType === 'pk') {
        name += ' (PK)';
      } else if (col.columnType === 'fk') {
        name += ' (FK)';
      }
      return `${name} - ${col.dataType}`;
    });

    const updatedNode = {
      ...node,
      data: {
        ...node.data,
        label: tableName,
        columns: columnStrings
      }
    };

    // Create edges for FK relationships
    const newEdges = [...edges];
    
    // Remove existing edges from this table
    const filteredEdges = newEdges.filter(edge => edge.source !== node.id);
    
    // Add new edges for FK columns
    columns.forEach(col => {
      if (col.columnType === 'fk' && col.referencedTable && col.referencedColumn) {
        const edgeId = `${col.referencedTable}-${node.id}`;
        const newEdge = {
          id: edgeId,
          source: col.referencedTable,
          target: node.id,
          sourceHandle: `${nodes.find(n => n.id === col.referencedTable)?.data.label}-${col.referencedColumn}`,
          targetHandle: `${tableName}-${col.name}`,
          animated: true,
          style: {
            stroke: '#d946ef'
          },
          markerEnd: {
            type: MarkerType.Arrow,
            color: '#d946ef'
          }
        };
        filteredEdges.push(newEdge);
      }
    });

         // Update edges state
     onUpdateEdges(filteredEdges);
    
    onSave(updatedNode);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-cyan-500/30 rounded-lg p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-cyan-400 flex items-center gap-2">
            <Database className="w-5 h-5" />
            Edit Table
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Table Name */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Table Name
            </label>
            <input
              type="text"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none"
            />
          </div>

          {/* Columns */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-300">
                Columns
              </label>
              <button
                onClick={addColumn}
                className="px-2 py-1 bg-cyan-900/30 border border-cyan-500/30 text-cyan-400 rounded text-xs hover:bg-cyan-900/50 transition-colors flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Add Column
              </button>
            </div>
            
            {/* Column Headers */}
            <div className="grid grid-cols-12 items-center gap-2 mb-2 text-xs text-gray-400 font-medium">
              <div className="col-span-3">Column Name</div>
              <div className="col-span-2">Data Type</div>
              <div className="col-span-2">Type</div>
              <div className="col-span-4">References (FK only)</div>
              <div className="col-span-1"></div>
            </div>
            
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {columns.map((column, index) => (
                <div key={index} className="grid grid-cols-12 items-center gap-2">
                  {/* Column Name */}
                  <input
                    type="text"
                    placeholder="Column name"
                    value={column.name}
                    onChange={(e) => updateColumn(index, 'name', e.target.value)}
                    className="col-span-3 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none text-sm"
                  />
                  
                  {/* Data Type */}
                  <input
                    type="text"
                    placeholder="Data type"
                    value={column.dataType}
                    onChange={(e) => updateColumn(index, 'dataType', e.target.value)}
                    className="col-span-2 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none text-sm"
                  />
                  
                  {/* Column Type */}
                  <select
                    value={column.columnType}
                    onChange={(e) => updateColumn(index, 'columnType', e.target.value)}
                    className="col-span-2 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none text-sm"
                  >
                    <option value="regular">Regular</option>
                    <option value="pk">Primary Key</option>
                    <option value="fk">Foreign Key</option>
                  </select>
                  
                  {/* FK Reference (only show for FK columns) */}
                  {column.columnType === 'fk' && (
                    <>
                      <select
                        value={column.referencedTable || ''}
                        onChange={(e) => updateColumn(index, 'referencedTable', e.target.value)}
                        className="col-span-2 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none text-sm"
                      >
                        <option value="">Select table...</option>
                        {getAvailableTables().map((table) => (
                          <option key={table.id} value={table.id}>
                            {table.label}
                          </option>
                        ))}
                      </select>
                      
                      <select
                        value={column.referencedColumn || ''}
                        onChange={(e) => updateColumn(index, 'referencedColumn', e.target.value)}
                        disabled={!column.referencedTable}
                        className="col-span-2 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:border-cyan-500 focus:outline-none text-sm disabled:opacity-50"
                      >
                        <option value="">Select column...</option>
                        {column.referencedTable && getAvailableColumns(column.referencedTable).map((col) => (
                          <option key={col.name} value={col.name}>
                            {col.label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  
                  {/* Spacer for non-FK columns */}
                  {column.columnType !== 'fk' && <div className="col-span-4"></div>}
                  
                  {/* Remove Button */}
                  <button
                    onClick={() => removeColumn(index)}
                    className="col-span-1 flex items-center justify-center p-1 text-red-400 hover:text-red-300 hover:bg-red-600/10 rounded transition-colors"
                    title="Delete column"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-6">
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg transition-colors"
          >
            Save Changes
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};