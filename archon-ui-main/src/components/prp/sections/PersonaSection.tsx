import React, { useState } from 'react';
import { Target, Zap } from 'lucide-react';
import { SectionProps, PRPPersona } from '../types/prp.types';

/**
 * Renders user personas with expandable cards
 */
export const PersonaSection: React.FC<SectionProps> = ({
  title,
  data,
  icon,
  accentColor = 'purple',
  defaultOpen = true,
  isDarkMode = false,
}) => {
  if (!data || typeof data !== 'object') return null;
  
  return (
    <div className="grid gap-4">
      {Object.entries(data).map(([key, persona]) => (
        <PersonaCard key={key} persona={persona as PRPPersona} personaKey={key} />
      ))}
    </div>
  );
};

interface PersonaCardProps {
  persona: PRPPersona;
  personaKey: string;
}

const PersonaCard: React.FC<PersonaCardProps> = ({ persona, personaKey }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const getPersonaIcon = (key: string) => {
    if (key.includes('admin')) return '👨‍💼';
    if (key.includes('formulator')) return '🧪';
    if (key.includes('purchasing')) return '💰';
    if (key.includes('developer')) return '👨‍💻';
    if (key.includes('designer')) return '🎨';
    if (key.includes('manager')) return '👔';
    if (key.includes('customer')) return '🛍️';
    return '👤';
  };
  
  const renderJourney = (journey: Record<string, any>) => {
    return (
      <div className="space-y-1">
        {Object.entries(journey).map(([stage, description]) => (
          <div key={stage} className="flex items-start gap-2 text-sm">
            <span className="font-medium text-gray-700 dark:text-gray-300 capitalize min-w-[100px]">
              {stage}:
            </span>
            <span className="text-gray-600 dark:text-gray-400">
              {typeof description === 'string' ? description : JSON.stringify(description)}
            </span>
          </div>
        ))}
      </div>
    );
  };
  
  const renderWorkflow = (workflow: Record<string, any>) => {
    return (
      <div className="space-y-1">
        {Object.entries(workflow).map(([time, task]) => (
          <div key={time} className="flex items-start gap-2 text-sm">
            <span className="font-medium text-gray-700 dark:text-gray-300 capitalize min-w-[100px]">
              {time}:
            </span>
            <span className="text-gray-600 dark:text-gray-400">
              {typeof task === 'string' ? task : JSON.stringify(task)}
            </span>
          </div>
        ))}
      </div>
    );
  };
  
  return (
    <div className="group">
      <div 
        className="p-6 rounded-xl bg-gradient-to-br from-white/80 to-white/60 dark:from-gray-800/50 dark:to-gray-900/50 border border-gray-200 dark:border-gray-700 hover:border-purple-400 dark:hover:border-purple-500 transition-all duration-300 shadow-lg hover:shadow-xl hover:scale-[1.02] cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-start gap-4">
          <div className="text-4xl">{getPersonaIcon(personaKey)}</div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
              {persona.name || personaKey}
            </h3>
            {persona.role && (
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{persona.role}</p>
            )}
            
            {/* Always visible goals */}
            {persona.goals && Array.isArray(persona.goals) && persona.goals.length > 0 && (
              <div className="mb-3">
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                  <Target className="w-4 h-4 text-green-500" />
                  Goals
                </h4>
                <ul className="space-y-1">
                  {persona.goals.slice(0, isExpanded ? undefined : 2).map((goal: string, idx: number) => (
                    <li key={idx} className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
                      <span className="text-green-500 mt-0.5">•</span>
                      {goal}
                    </li>
                  ))}
                  {!isExpanded && persona.goals.length > 2 && (
                    <li className="text-sm text-gray-500 dark:text-gray-500 italic">
                      +{persona.goals.length - 2} more...
                    </li>
                  )}
                </ul>
              </div>
            )}
            
            {/* Expandable content */}
            {isExpanded && (
              <>
                {persona.pain_points && Array.isArray(persona.pain_points) && persona.pain_points.length > 0 && (
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                      <Zap className="w-4 h-4 text-orange-500" />
                      Pain Points
                    </h4>
                    <ul className="space-y-1">
                      {persona.pain_points.map((point: string, idx: number) => (
                        <li key={idx} className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
                          <span className="text-orange-500 mt-0.5">•</span>
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {persona.journey && Object.keys(persona.journey).length > 0 && (
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      User Journey
                    </h4>
                    {renderJourney(persona.journey)}
                  </div>
                )}
                
                {persona.workflow && Object.keys(persona.workflow).length > 0 && (
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      Daily Workflow
                    </h4>
                    {renderWorkflow(persona.workflow)}
                  </div>
                )}
                
                {/* Render any other fields */}
                {Object.entries(persona).map(([key, value]) => {
                  if (['name', 'role', 'goals', 'pain_points', 'journey', 'workflow'].includes(key)) {
                    return null;
                  }
                  return (
                    <div key={key} className="mb-3">
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 capitalize">
                        {key.replace(/_/g, ' ')}
                      </h4>
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
        
        <div className="mt-3 text-xs text-gray-500 dark:text-gray-500 text-right">
          Click to {isExpanded ? 'collapse' : 'expand'} details
        </div>
      </div>
    </div>
  );
};