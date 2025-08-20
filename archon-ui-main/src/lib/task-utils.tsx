import { User, Bot, Tag, Clipboard } from 'lucide-react';
import React from 'react';

export const ItemTypes = {
  TASK: 'task'
};

export const getAssigneeIcon = (assigneeName: 'User' | 'Archon' | 'AI IDE Agent') => {
  switch (assigneeName) {
    case 'User':
      return <User className="w-4 h-4 text-blue-400" />;
    case 'AI IDE Agent':
      return <Bot className="w-4 h-4 text-purple-400" />;
    case 'Archon':
      return <img src="/logo-neon.png" alt="Archon" className="w-4 h-4" />;
    default:
      return <User className="w-4 h-4 text-blue-400" />;
  }
};

export const getAssigneeGlow = (assigneeName: 'User' | 'Archon' | 'AI IDE Agent') => {
  switch (assigneeName) {
    case 'User':
      return 'shadow-[0_0_10px_rgba(59,130,246,0.4)]';
    case 'AI IDE Agent':
      return 'shadow-[0_0_10px_rgba(168,85,247,0.4)]';
    case 'Archon':
      return 'shadow-[0_0_10px_rgba(34,211,238,0.4)]';
    default:
      return 'shadow-[0_0_10px_rgba(59,130,246,0.4)]';
  }
};

export const getOrderColor = (order: number) => {
  if (order <= 3) return 'bg-rose-500';
  if (order <= 6) return 'bg-orange-500';
  if (order <= 10) return 'bg-blue-500';
  return 'bg-emerald-500';
};

export const getOrderGlow = (order: number) => {
  if (order <= 3) return 'shadow-[0_0_10px_rgba(244,63,94,0.7)]';
  if (order <= 6) return 'shadow-[0_0_10px_rgba(249,115,22,0.7)]';
  if (order <= 10) return 'shadow-[0_0_10px_rgba(59,130,246,0.7)]';
  return 'shadow-[0_0_10px_rgba(16,185,129,0.7)]';
}; 