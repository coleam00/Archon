import React, { useEffect, useState, useRef } from 'react';
import { Server, Activity, Clock, ChevronRight, Hammer, Settings, Trash2, Plug, PlugZap } from 'lucide-react';
import { Client } from './MCPClients';
import { mcpClientService } from '../../services/mcpClientService';
import { useToast } from '../../contexts/ToastContext';

interface ClientCardProps {
  client: Client;
  onSelect: () => void;
  onEdit?: (client: Client) => void;
  onDelete?: (client: Client) => void;
  onConnectionChange?: () => void;
}

export const ClientCard = ({
  client,
  onSelect,
  onEdit,
  onDelete,
  onConnectionChange
}: ClientCardProps) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const particlesRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  // Special styling for Archon client
  const isArchonClient = client.name.includes('Archon') || client.name.includes('archon');

  // Status-based styling
  const statusConfig = {
    online: {
      color: isArchonClient ? 'archon' : 'cyan',
      glow: isArchonClient ? 'shadow-[0_0_25px_rgba(59,130,246,0.7),0_0_15px_rgba(168,85,247,0.5)] dark:shadow-[0_0_35px_rgba(59,130,246,0.8),0_0_20px_rgba(168,85,247,0.7)]' : 'shadow-[0_0_15px_rgba(34,211,238,0.5)] dark:shadow-[0_0_20px_rgba(34,211,238,0.7)]',
      border: isArchonClient ? 'border-blue-400/60 dark:border-blue-500/60' : 'border-cyan-400/50 dark:border-cyan-500/40',
      badge: isArchonClient ? 'bg-blue-500/30 text-blue-400 border-blue-500/40' : 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
      pulse: isArchonClient ? 'bg-blue-400' : 'bg-cyan-400'
    },
    offline: {
      color: 'gray',
      glow: 'shadow-[0_0_15px_rgba(156,163,175,0.3)] dark:shadow-[0_0_15px_rgba(156,163,175,0.4)]',
      border: 'border-gray-400/30 dark:border-gray-600/30',
      badge: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      pulse: 'bg-gray-400'
    },
    error: {
      color: 'pink',
      glow: 'shadow-[0_0_15px_rgba(236,72,153,0.5)] dark:shadow-[0_0_20px_rgba(236,72,153,0.7)]',
      border: 'border-pink-400/50 dark:border-pink-500/40',
      badge: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
      pulse: 'bg-pink-400'
    }
  };

  // Handle mouse movement for bioluminescent effect
  useEffect(() => {
    if (!isArchonClient || !particlesRef.current) return;

    const currentMousePos = { x: 0, y: 0 };
    const glowOrganisms: HTMLDivElement[] = [];
    let isMousePresent = false;

    const createBioluminescentOrganism = (targetX: number, targetY: number, delay = 0) => {
      const organism = document.createElement('div');
      organism.className = 'absolute rounded-full pointer-events-none';
      
      const startX = targetX + (Math.random() - 0.5) * 100;
      const startY = targetY + (Math.random() - 0.5) * 100;
      const size = 8 + Math.random() * 12;
      
      organism.style.left = `${startX}px`;
      organism.style.top = `${startY}px`;
      organism.style.width = `${size}px`;
      organism.style.height = `${size}px`;
      organism.style.transform = 'translate(-50%, -50%)';
      organism.style.opacity = '0';
      
      const hues = [180, 200, 220, 240, 260, 280];
      const hue = hues[Math.floor(Math.random() * hues.length)];
      
      organism.style.background = 'transparent';
      
      organism.style.boxShadow = `
        0 0 ${size * 2}px hsla(${hue}, 90%, 60%, 0.4),
        0 0 ${size * 4}px hsla(${hue}, 80%, 50%, 0.25),
        0 0 ${size * 6}px hsla(${hue}, 70%, 40%, 0.15),
        0 0 ${size * 8}px hsla(${hue}, 60%, 30%, 0.08)
      `;
      
      organism.style.filter = `blur(${2 + Math.random() * 3}px) opacity(0.6)`;
      
      particlesRef.current?.appendChild(organism);
      
      setTimeout(() => {
        const duration = 1200 + Math.random() * 800;
        
        organism.style.transition = `all ${duration}ms cubic-bezier(0.2, 0.0, 0.1, 1)`;
        organism.style.left = `${targetX + (Math.random() - 0.5) * 50}px`;
        organism.style.top = `${targetY + (Math.random() - 0.5) * 50}px`;
        organism.style.opacity = '0.8';
        organism.style.transform = 'translate(-50%, -50%) scale(1.2)';
        
        setTimeout(() => {
          if (!isMousePresent) {
            organism.style.transition = `all 2500ms cubic-bezier(0.6, 0.0, 0.9, 1)`;
            organism.style.left = `${startX + (Math.random() - 0.5) * 300}px`;
            organism.style.top = `${startY + (Math.random() - 0.5) * 300}px`;
            organism.style.opacity = '0';
            organism.style.transform = 'translate(-50%, -50%) scale(0.2)';
            organism.style.filter = `blur(${8 + Math.random() * 5}px) opacity(0.2)`;
          }
        }, duration + 800);
        
        setTimeout(() => {
          if (particlesRef.current?.contains(organism)) {
            particlesRef.current.removeChild(organism);
            const index = glowOrganisms.indexOf(organism);
            if (index > -1) glowOrganisms.splice(index, 1);
          }
        }, duration + 2000);
        
      }, delay);
      
      return organism;
    };

    const spawnOrganismsTowardMouse = () => {
      if (!isMousePresent) return;
      
      const count = 3 + Math.random() * 4;
      for (let i = 0; i < count; i++) {
        const organism = createBioluminescentOrganism(
          currentMousePos.x,
          currentMousePos.y,
          i * 100
        );
        glowOrganisms.push(organism);
      }
    };

    const handleMouseEnter = () => {
      isMousePresent = true;
      clearInterval(ambientInterval);
      ambientInterval = setInterval(createAmbientGlow, 1500);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!particlesRef.current) return;
      
      const rect = particlesRef.current.getBoundingClientRect();
      currentMousePos.x = e.clientX - rect.left;
      currentMousePos.y = e.clientY - rect.top;
      
      isMousePresent = true;
      
      if (Math.random() < 0.4) {
        spawnOrganismsTowardMouse();
      }
    };

    const handleMouseLeave = () => {
      setTimeout(() => {
        isMousePresent = false;
        clearInterval(ambientInterval);
      }, 800);
    };

    const createAmbientGlow = () => {
      if (!particlesRef.current || isMousePresent) return;
      
      const x = Math.random() * particlesRef.current.clientWidth;
      const y = Math.random() * particlesRef.current.clientHeight;
      const organism = createBioluminescentOrganism(x, y);
      
      organism.style.opacity = '0.3';
      organism.style.filter = `blur(${4 + Math.random() * 4}px) opacity(0.4)`;
      organism.style.animation = 'pulse 4s ease-in-out infinite';
      organism.style.transform = 'translate(-50%, -50%) scale(0.8)';
      
      glowOrganisms.push(organism);
    };

    let ambientInterval = setInterval(createAmbientGlow, 1500);

    const cardElement = particlesRef.current;
    cardElement.addEventListener('mouseenter', handleMouseEnter);
    cardElement.addEventListener('mousemove', handleMouseMove);
    cardElement.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      cardElement.removeEventListener('mouseenter', handleMouseEnter);
      cardElement.removeEventListener('mousemove', handleMouseMove);
      cardElement.removeEventListener('mouseleave', handleMouseLeave);
      clearInterval(ambientInterval);
    };
  }, [isArchonClient]);

  const currentStatus = statusConfig[client.status];

  // Handle card flip
  const toggleFlip = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsFlipped(!isFlipped);
  };

  // Handle edit
  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.(client);
  };

  // Handle connect/disconnect
  const handleConnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsConnecting(true);
    
    try {
      if (client.status === 'offline') {
        await mcpClientService.connectClient(client.id);
        showToast(`Connected to ${client.name}`, 'success');
      } else {
        await mcpClientService.disconnectClient(client.id);
        showToast(`Disconnected from ${client.name}`, 'success');
      }
      
      // The parent component should handle refreshing the client list
      // No need to reload the entire page
      onConnectionChange?.();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Connection operation failed', 'error');
    } finally {
      setIsConnecting(false);
    }
  };

  // Special background for Archon client
  const archonBackground = isArchonClient ? 'bg-gradient-to-b from-white/80 via-blue-50/30 to-white/60 dark:from-white/10 dark:via-blue-900/10 dark:to-black/30' : 'bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30';

  return (
    <div 
      className={`flip-card h-[220px] cursor-pointer ${isArchonClient ? 'order-first' : ''}`} 
      style={{ perspective: '1500px' }} 
      onClick={onSelect} 
      onMouseEnter={() => setIsHovered(true)} 
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={`relative w-full h-full transition-all duration-500 transform-style-preserve-3d ${isFlipped ? 'rotate-y-180' : ''} ${isHovered && !isFlipped ? 'hover-lift' : ''}`}>
        {/* Front Side */}
        <div 
          className={`absolute w-full h-full backface-hidden backdrop-blur-md ${archonBackground} rounded-xl p-5 ${currentStatus.border} ${currentStatus.glow} transition-all duration-300 ${isArchonClient ? 'archon-card-border overflow-hidden' : ''}`} 
          ref={isArchonClient ? particlesRef : undefined}
        >
          {/* Particle container for Archon client */}
          {isArchonClient && (
            <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
              <div className="particles-container"></div>
            </div>
          )}

          {/* Subtle aurora glow effect for Archon client */}
          {isArchonClient && (
            <div className="absolute inset-0 rounded-xl overflow-hidden opacity-20">
              <div className="absolute -inset-[100px] bg-[radial-gradient(circle,rgba(59,130,246,0.8)_0%,rgba(168,85,247,0.6)_40%,transparent_70%)] blur-3xl animate-[pulse_8s_ease-in-out_infinite]"></div>
            </div>
          )}

          {/* Connect/Disconnect button */}
          <button 
            onClick={handleConnect}
            disabled={isConnecting}
            className={`absolute top-3 right-3 p-1.5 rounded-full ${
              client.status === 'offline' 
                ? 'bg-green-200/50 dark:bg-green-900/50 hover:bg-green-300/50 dark:hover:bg-green-800/50' 
                : 'bg-orange-200/50 dark:bg-orange-900/50 hover:bg-orange-300/50 dark:hover:bg-orange-800/50'
            } transition-colors transform hover:scale-110 transition-transform duration-200 z-20 ${isConnecting ? 'animate-pulse' : ''}`} 
            title={client.status === 'offline' ? 'Connect client' : 'Disconnect client'}
          >
            {client.status === 'offline' ? (
              <Plug className="w-4 h-4 text-green-600 dark:text-green-400" />
            ) : (
              <PlugZap className="w-4 h-4 text-orange-600 dark:text-orange-400" />
            )}
          </button>

          {/* Edit button - moved to be second from right */}
          {onEdit && (
            <button 
              onClick={handleEdit} 
              className={`absolute top-3 right-12 p-1.5 rounded-full ${isArchonClient ? 'bg-blue-200/50 dark:bg-blue-900/50 hover:bg-blue-300/50 dark:hover:bg-blue-800/50' : 'bg-gray-200/50 dark:bg-gray-800/50 hover:bg-gray-300/50 dark:hover:bg-gray-700/50'} transition-colors transform hover:scale-110 transition-transform duration-200 z-20`} 
              title="Edit client configuration"
            >
              <Settings className={`w-4 h-4 ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`} />
            </button>
          )}

          {/* Delete button - only for non-Archon clients */}
          {!isArchonClient && onDelete && (
            <button 
              onClick={(e) => {
                e.stopPropagation();
                onDelete(client);
              }} 
              className="absolute top-3 right-[84px] p-1.5 rounded-full bg-red-200/50 dark:bg-red-900/50 hover:bg-red-300/50 dark:hover:bg-red-800/50 transition-colors transform hover:scale-110 transition-transform duration-200 z-20"
              title="Delete client"
            >
              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            </button>
          )}

          {/* Client info */}
          <div className="flex items-start">
            {isArchonClient ? (
              <div className="p-3 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 mr-3 relative pulse-soft">
                <img src="/logo-neon.png" alt="Archon" className="w-6 h-6 drop-shadow-[0_0_8px_rgba(59,130,246,0.8)] animate-glow-pulse" />
                <div className="absolute inset-0 rounded-lg bg-blue-500/10 animate-pulse opacity-60"></div>
              </div>
            ) : (
              <div className={`p-3 rounded-lg bg-${currentStatus.color}-500/10 text-${currentStatus.color}-400 mr-3 pulse-soft`}>
                <Server className="w-6 h-6" />
              </div>
            )}
            
            <div>
              <h3 className={`font-bold text-gray-800 dark:text-white text-lg ${isArchonClient ? 'bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text animate-text-shimmer' : ''}`}>
                {client.name}
              </h3>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                {client.ip}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <div className="flex items-center text-sm">
              <Clock className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2" />
              <span className="text-gray-700 dark:text-gray-300">Last seen:</span>
              <span className="text-gray-600 dark:text-gray-400 ml-auto">
                {client.lastSeen}
              </span>
            </div>
            <div className="flex items-center text-sm">
              <Activity className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2" />
              <span className="text-gray-700 dark:text-gray-300">Version:</span>
              <span className={`text-gray-600 dark:text-gray-400 ml-auto ${isArchonClient ? 'font-medium text-blue-600 dark:text-blue-400' : ''}`}>
                {client.version}
              </span>
            </div>
            <div className="flex items-center text-sm">
              <Hammer className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2" />
              <span className="text-gray-700 dark:text-gray-300">Tools:</span>
              <span className={`text-gray-600 dark:text-gray-400 ml-auto ${isArchonClient ? 'font-medium text-blue-600 dark:text-blue-400' : ''}`}>
                {client.tools.length} available
              </span>
            </div>
            
            {/* Error message display */}
            {client.status === 'error' && client.lastError && (
              <div className="mt-3 p-2 bg-red-50/80 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-md">
                <div className="flex items-start">
                  <div className="w-3 h-3 rounded-full bg-red-400 mt-0.5 mr-2 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">Last Error:</p>
                    <p className="text-xs text-red-600 dark:text-red-400 break-words">
                      {client.lastError}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Status badge - moved to bottom left */}
          <div className="absolute bottom-4 left-4">
            <div className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border ${currentStatus.badge}`}>
              <div className="relative flex h-2 w-2">
                <span className={`animate-ping-slow absolute inline-flex h-full w-full rounded-full ${currentStatus.pulse} opacity-75`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${currentStatus.pulse}`}></span>
              </div>
              {client.status.charAt(0).toUpperCase() + client.status.slice(1)}
            </div>
          </div>

          {/* Tools button - with Hammer icon */}
          <button 
            onClick={toggleFlip} 
            className={`absolute bottom-4 right-4 p-1.5 rounded-full ${isArchonClient ? 'bg-blue-200/50 dark:bg-blue-900/50 hover:bg-blue-300/50 dark:hover:bg-blue-800/50' : 'bg-gray-200/50 dark:bg-gray-800/50 hover:bg-gray-300/50 dark:hover:bg-gray-700/50'} transition-colors transform hover:scale-110 transition-transform duration-200 z-10`} 
            title="View available tools"
          >
            <Hammer className={`w-4 h-4 ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`} />
          </button>
        </div>

        {/* Back Side */}
        <div className={`absolute w-full h-full backface-hidden backdrop-blur-md ${archonBackground} rounded-xl p-5 rotate-y-180 ${currentStatus.border} ${currentStatus.glow} transition-all duration-300 ${isArchonClient ? 'archon-card-border' : ''}`}>
          {/* Subtle aurora glow effect for Archon client */}
          {isArchonClient && (
            <div className="absolute inset-0 rounded-xl overflow-hidden opacity-20">
              <div className="absolute -inset-[100px] bg-[radial-gradient(circle,rgba(59,130,246,0.8)_0%,rgba(168,85,247,0.6)_40%,transparent_70%)] blur-3xl animate-[pulse_8s_ease-in-out_infinite]"></div>
            </div>
          )}

          {/* Connect/Disconnect button - also on back side */}
          <button 
            onClick={handleConnect}
            disabled={isConnecting}
            className={`absolute top-3 right-3 p-1.5 rounded-full ${
              client.status === 'offline' 
                ? 'bg-green-200/50 dark:bg-green-900/50 hover:bg-green-300/50 dark:hover:bg-green-800/50' 
                : 'bg-orange-200/50 dark:bg-orange-900/50 hover:bg-orange-300/50 dark:hover:bg-orange-800/50'
            } transition-colors transform hover:scale-110 transition-transform duration-200 z-20 ${isConnecting ? 'animate-pulse' : ''}`} 
            title={client.status === 'offline' ? 'Connect client' : 'Disconnect client'}
          >
            {client.status === 'offline' ? (
              <Plug className="w-4 h-4 text-green-600 dark:text-green-400" />
            ) : (
              <PlugZap className="w-4 h-4 text-orange-600 dark:text-orange-400" />
            )}
          </button>

          {/* Edit button - also on back side */}
          {onEdit && (
            <button 
              onClick={handleEdit} 
              className={`absolute top-3 right-12 p-1.5 rounded-full ${isArchonClient ? 'bg-blue-200/50 dark:bg-blue-900/50 hover:bg-blue-300/50 dark:hover:bg-blue-800/50' : 'bg-gray-200/50 dark:bg-gray-800/50 hover:bg-gray-300/50 dark:hover:bg-gray-700/50'} transition-colors transform hover:scale-110 transition-transform duration-200 z-20`} 
              title="Edit client configuration"
            >
              <Settings className={`w-4 h-4 ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`} />
            </button>
          )}

          {/* Delete button on back side - only for non-Archon clients */}
          {!isArchonClient && onDelete && (
            <button 
              onClick={(e) => {
                e.stopPropagation();
                onDelete(client);
              }} 
              className="absolute top-3 right-[84px] p-1.5 rounded-full bg-red-200/50 dark:bg-red-900/50 hover:bg-red-300/50 dark:hover:bg-red-800/50 transition-colors transform hover:scale-110 transition-transform duration-200 z-20"
              title="Delete client"
            >
              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            </button>
          )}

          <h3 className={`font-bold text-gray-800 dark:text-white mb-3 flex items-center ${isArchonClient ? 'bg-gradient-to-r from-blue-400 to-purple-500 text-transparent bg-clip-text animate-text-shimmer' : ''}`}>
            <Hammer className={`w-4 h-4 mr-2 ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`} />
            Available Tools ({client.tools.length})
          </h3>

          <div className="space-y-2 overflow-y-auto max-h-[140px] pr-1 hide-scrollbar">
            {client.tools.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                  {client.status === 'offline' 
                    ? 'Client offline - tools unavailable'
                    : 'No tools discovered'}
                </p>
              </div>
            ) : (
              client.tools.map(tool => (
                <div 
                  key={tool.id} 
                  className={`p-2 rounded-md ${isArchonClient ? 'bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700/50 hover:border-blue-300 dark:hover:border-blue-600/50' : 'bg-gray-100/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700/50 hover:border-gray-300 dark:hover:border-gray-600/50'} transition-colors transform hover:translate-x-1 transition-transform duration-200`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-mono text-xs ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-blue-600 dark:text-blue-400'}`}>
                      {tool.name}
                    </span>
                    <ChevronRight className="w-3 h-3 text-gray-400" />
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                    {tool.description}
                  </p>
                  {tool.parameters.length > 0 && (
                    <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                      {tool.parameters.length} parameter{tool.parameters.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Status badge - also at bottom left on back side */}
          <div className="absolute bottom-4 left-4">
            <div className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border ${currentStatus.badge}`}>
              <div className="relative flex h-2 w-2">
                <span className={`animate-ping-slow absolute inline-flex h-full w-full rounded-full ${currentStatus.pulse} opacity-75`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${currentStatus.pulse}`}></span>
              </div>
              {client.status.charAt(0).toUpperCase() + client.status.slice(1)}
            </div>
          </div>

          {/* Flip button - back to front */}
          <button 
            onClick={toggleFlip} 
            className={`absolute bottom-4 right-4 p-1.5 rounded-full ${isArchonClient ? 'bg-blue-200/50 dark:bg-blue-900/50 hover:bg-blue-300/50 dark:hover:bg-blue-800/50' : 'bg-gray-200/50 dark:bg-gray-800/50 hover:bg-gray-300/50 dark:hover:bg-gray-700/50'} transition-colors transform hover:scale-110 transition-transform duration-200 z-10`} 
            title="Show client details"
          >
            <Server className={`w-4 h-4 ${isArchonClient ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`} />
          </button>
        </div>
      </div>
    </div>
  );
};