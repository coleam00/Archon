import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PowerButton } from '../../../components/ui/PowerButton';
import { LucideIcon } from 'lucide-react';

type AccentColor = 'purple' | 'green' | 'pink' | 'blue' | 'cyan' | 'orange';

interface CollapsibleSettingsCardProps {
  title: string;
  icon: LucideIcon;
  accentColor?: AccentColor;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  storageKey?: string;
}

export const CollapsibleSettingsCard: React.FC<CollapsibleSettingsCardProps> = ({
  title,
  icon: Icon,
  accentColor = 'blue',
  children,
  defaultExpanded = true,
  storageKey
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [isFlickering, setIsFlickering] = useState(false);

  useEffect(() => {
    if (storageKey) {
      const saved = localStorage.getItem(`settings-card-${storageKey}`);
      if (saved !== null) {
        setIsExpanded(saved === 'true');
      }
    }
  }, [storageKey]);

  const handleToggle = () => {
    if (isExpanded) {
      setIsFlickering(true);
      setTimeout(() => {
        setIsExpanded(false);
        setIsFlickering(false);
        if (storageKey) {
          localStorage.setItem(`settings-card-${storageKey}`, 'false');
        }
      }, 300);
    } else {
      setIsExpanded(true);
      if (storageKey) {
        localStorage.setItem(`settings-card-${storageKey}`, 'true');
      }
    }
  };

  const iconColorMap = {
    purple: 'text-purple-500 filter drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]',
    green: 'text-green-500 filter drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]',
    pink: 'text-pink-500 filter drop-shadow-[0_0_8px_rgba(236,72,153,0.8)]',
    blue: 'text-blue-500 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]',
    cyan: 'text-cyan-500 filter drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]',
    orange: 'text-orange-500 filter drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]'
  } satisfies Record<AccentColor, string>;

  return (
    <motion.div
      animate={isFlickering ? {
        opacity: [1, 0.3, 1, 0.5, 1, 0.2, 1],
      } : {}}
      transition={{
        duration: 0.3,
        times: [0, 0.1, 0.2, 0.3, 0.6, 0.8, 1],
      }}
    >
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <Icon className={`mr-2 ${iconColorMap[accentColor]} size-5`} />
            <h2 className="text-xl font-semibold text-gray-800 dark:text-white">
              {title}
            </h2>
          </div>
          <PowerButton
            isOn={isExpanded}
            onClick={handleToggle}
            color={accentColor}
            size={36}
          />
        </div>

        <AnimatePresence mode="wait">
          {isExpanded && !isFlickering && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                height: {
                  duration: 0.3,
                  ease: [0.04, 0.62, 0.23, 0.98]
                },
                opacity: {
                  duration: 0.2,
                  ease: "easeInOut"
                }
              }}
              style={{ overflow: 'hidden' }}
            >
              <motion.div
                initial={{ y: -20 }}
                animate={{ y: 0 }}
                exit={{ y: -20 }}
                transition={{
                  duration: 0.2,
                  ease: "easeOut"
                }}
              >
                {children}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};
