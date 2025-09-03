import React, { useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Edit, Trash2, RefreshCw, Tag, Clipboard } from 'lucide-react';
import { Task } from './TaskTableView';
import { ItemTypes, getAssigneeIcon, getAssigneeGlow, getOrderColor, getOrderGlow } from '../../lib/task-utils';
import { useToast } from '../../contexts/ToastContext';

export interface DraggableTaskCardProps {
  task: Task;
  index: number;
  onView: () => void;
  onComplete: () => void;
  onDelete: (task: Task) => void;
  onTaskReorder: (taskId: string, targetIndex: number, status: Task['status']) => void;
  hoveredTaskId?: string | null;
  onTaskHover?: (taskId: string | null) => void;
  selectedTasks?: Set<string>;
  onTaskSelect?: (taskId: string) => void;
}

export const DraggableTaskCard = ({
  task,
  index,
  onView,
  onComplete,
  onDelete,
  onTaskReorder,
  hoveredTaskId,
  onTaskHover,
  selectedTasks,
  onTaskSelect,
}: DraggableTaskCardProps) => {
  const { showToast } = useToast();
  
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TASK,
    item: { id: task.id, status: task.status, index },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging()
    })
  });

  const [, drop] = useDrop({
    accept: ItemTypes.TASK,
    hover: (draggedItem: { id: string; status: Task['status']; index: number }, monitor) => {
      if (!monitor.isOver({ shallow: true })) return;
      if (draggedItem.id === task.id) return;
      if (draggedItem.status !== task.status) return;
      
      const draggedIndex = draggedItem.index;
      const hoveredIndex = index;
      
      if (draggedIndex === hoveredIndex) return;
      
      
      // Move the task immediately for visual feedback (same pattern as table view)
      onTaskReorder(draggedItem.id, hoveredIndex, task.status);
      
      // Update the dragged item's index to prevent re-triggering
      draggedItem.index = hoveredIndex;
    }
  });

  const [isFlipped, setIsFlipped] = useState(false);
  
  const toggleFlip = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsFlipped(!isFlipped);
  };

  const isHighlighted = hoveredTaskId === task.id;
  const isSelected = selectedTasks?.has(task.id) || false;

  const handleMouseEnter = () => {
    onTaskHover?.(task.id);
  };

  const handleMouseLeave = () => {
    onTaskHover?.(null);
  };

  const handleTaskClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      onTaskSelect?.(task.id);
    }
  };

  
  // Card styling - using CSS-based height animation for better scrolling
  
  // Card styling constants
  const cardScale = 'scale-100';
  const cardOpacity = 'opacity-100';
  
  // Subtle highlight effect for related tasks - applied to the card, not parent
  const highlightGlow = isHighlighted 
    ? 'border-cyan-400/50 shadow-[0_0_8px_rgba(34,211,238,0.2)]' 
    : '';
    
  // Selection styling
  const selectionGlow = isSelected
    ? 'border-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.4)] bg-blue-50/30 dark:bg-blue-900/20'
    : '';
    
  // Simplified hover effect - just a glowing border
  const hoverEffectClasses = 'group-hover:border-cyan-400/70 dark:group-hover:border-cyan-500/50 group-hover:shadow-[0_0_15px_rgba(34,211,238,0.4)] dark:group-hover:shadow-[0_0_15px_rgba(34,211,238,0.6)]';
  
  // Base card styles with proper rounded corners
  const cardBaseStyles = 'bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border border-gray-200 dark:border-gray-700 rounded-lg';
  
  // Transition settings
  const transitionStyles = 'transition-all duration-200 ease-in-out';

  return (
    <div 
      ref={(node) => drag(drop(node))}
      style={{ 
        perspective: '1000px',
        transformStyle: 'preserve-3d'
      }}
      className={`flip-card w-full min-h-[140px] cursor-move relative ${cardScale} ${cardOpacity} ${isDragging ? 'opacity-50 scale-90' : ''} ${transitionStyles} group`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTaskClick}
    >
      <div 
        className={`relative w-full min-h-[140px] transform-style-preserve-3d ${isFlipped ? 'rotate-y-180' : ''}`}
      >
        {/* Front side with subtle hover effect */}
        <div className={`absolute w-full h-full backface-hidden ${cardBaseStyles} ${transitionStyles} ${hoverEffectClasses} ${highlightGlow} ${selectionGlow} rounded-lg`}>
          {/* Priority indicator */}
          <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${getOrderColor(task.task_order)} ${getOrderGlow(task.task_order)} rounded-l-lg opacity-80 group-hover:w-[4px] group-hover:opacity-100 transition-all duration-300`}></div>
          
          {/* Content container with fixed padding - exactly matching back side structure */}
          <div className="flex flex-col h-full p-3">
            <div className="flex items-center gap-2 mb-2 pl-1.5">
              <div className="px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 backdrop-blur-md" 
                   style={{
                     backgroundColor: `${task.featureColor}20`,
                     color: task.featureColor,
                     boxShadow: `0 0 10px ${task.featureColor}20`
                   }}
              >
                <Tag className="w-3 h-3" />
                {task.feature}
              </div>
              
              {/* Task order display */}
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white ${getOrderColor(task.task_order)}`}>
                {task.task_order}
              </div>
              
              {/* Action buttons group */}
              <div className="ml-auto flex items-center gap-1.5">
                <button 
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(task);
                  }} 
                  className="w-5 h-5 rounded-full flex items-center justify-center bg-red-100/80 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)] transition-all duration-300"
                  title="Delete task"
                  aria-label="Delete task"
                >
                  <Trash2 className="w-3 h-3" aria-hidden="true" />
                </button>
                <button 
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onView();
                  }} 
                  className="w-5 h-5 rounded-full flex items-center justify-center bg-cyan-100/80 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-200 dark:hover:bg-cyan-500/30 hover:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all duration-300"
                  title="Edit task"
                  aria-label="Edit task"
                >
                  <Edit className="w-3 h-3" aria-hidden="true" />
                </button>
                <button 
                  type="button"
                  onClick={toggleFlip} 
                  className="w-5 h-5 rounded-full flex items-center justify-center bg-cyan-100/80 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-200 dark:hover:bg-cyan-500/30 hover:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all duration-300"
                  title="View task details"
                  aria-label="View task details"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            </div>
            
            <h4 className="text-xs font-medium text-gray-900 dark:text-white mb-2 pl-1.5 line-clamp-2 overflow-hidden" title={task.title}>
              {task.title}
            </h4>
            
            {/* Spacer to push assignee section to bottom */}
            <div className="flex-1"></div>
            
            <div className="flex items-center justify-between mt-auto pt-2 pl-1.5 pr-3">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-5 h-5 rounded-full bg-white/80 dark:bg-black/70 border border-gray-300/50 dark:border-gray-700/50 backdrop-blur-md" 
                     style={{boxShadow: getAssigneeGlow(task.assignee?.name || 'User')}}
                >
                  {getAssigneeIcon(task.assignee?.name || 'User')}
                </div>
                <span className="text-gray-600 dark:text-gray-400 text-xs">{task.assignee?.name || 'User'}</span>
              </div>
              <button 
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(task.id);
                    } else {
                      const ta = document.createElement('textarea');
                      ta.value = task.id;
                      ta.style.position = 'fixed';
                      ta.style.opacity = '0';
                      document.body.appendChild(ta);
                      ta.select();
                      document.execCommand('copy');
                      document.body.removeChild(ta);
                    }
                    showToast('Task ID copied to clipboard', 'success');
                  } catch (error) {
                    showToast('Failed to copy Task ID', 'error');
                  }
                }}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                title="Copy Task ID to clipboard"
                aria-label="Copy Task ID to clipboard"
              >
                <Clipboard className="w-3 h-3" aria-hidden="true" />
                <span>Task ID</span>
              </button>
            </div>
          </div>
        </div>
        
        {/* Back side */}
        {/* Back side with same hover effect */}
        <div className={`absolute w-full h-full backface-hidden ${cardBaseStyles} ${transitionStyles} ${hoverEffectClasses} ${highlightGlow} ${selectionGlow} rounded-lg rotate-y-180 ${isDragging ? 'opacity-0' : 'opacity-100'}`}>
          {/* Priority indicator */}
          <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${getOrderColor(task.task_order)} ${getOrderGlow(task.task_order)} rounded-l-lg opacity-80 group-hover:w-[4px] group-hover:opacity-100 transition-all duration-300`}></div>
          
          {/* Content container with fixed padding */}
          <div className="flex flex-col h-full p-3">
            <div className="flex items-center gap-2 mb-2 pl-1.5">
              <h4 className="text-xs font-medium text-gray-900 dark:text-white truncate max-w-[75%]">
                {task.title}
              </h4>
              <button 
                type="button"
                onClick={toggleFlip} 
                className="ml-auto w-5 h-5 rounded-full flex items-center justify-center bg-cyan-100/80 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-200 dark:hover:bg-cyan-500/30 hover:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all duration-300"
                title="Flip back to front"
                aria-label="Flip back to front"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
            
            {/* Description container with absolute positioning inside parent bounds */}
            <div className="flex-1 overflow-hidden relative">
              <div className="absolute inset-0 overflow-y-auto hide-scrollbar pl-1.5 pr-2">
                <p className="text-xs text-gray-700 dark:text-gray-300 break-words whitespace-pre-wrap" style={{fontSize: '11px'}}>{task.description}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}; 