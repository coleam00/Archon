import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Info, AlertCircle, X } from 'lucide-react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
}

interface ToastContextType {
  showToast: (message: string, type?: Toast['type'], duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: Toast['type'] = 'info', duration = 4000) => {
    // Use timestamp + random number to prevent duplicate keys
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: Toast = { id, message, type, duration };
    
    setToasts(prev => [...prev, newToast]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const getIcon = (type: Toast['type']) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'error':
        return <XCircle className="w-5 h-5 text-red-500" />;
      case 'warning':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      case 'info':
      default:
        return <Info className="w-5 h-5 text-blue-500" />;
    }
  };

  const getGlassmorphismStyles = (type: Toast['type']) => {
    switch (type) {
      case 'success':
        return {
          container: 'backdrop-blur-xl bg-gradient-to-r from-green-50/95 to-emerald-50/95 dark:from-green-950/90 dark:to-emerald-950/90 border border-green-300/60 dark:border-green-500/40 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_10px_10px_-5px_rgba(0,0,0,0.04)] dark:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.6),0_10px_10px_-5px_rgba(0,0,0,0.3)]',
          textColor: 'text-green-800 dark:text-green-100',
          buttonColor: 'text-green-600 hover:text-green-800 dark:text-green-300 dark:hover:text-green-100'
        };
      case 'error':
        return {
          container: 'backdrop-blur-xl bg-gradient-to-r from-red-50/95 to-pink-50/95 dark:from-red-950/90 dark:to-pink-950/90 border border-red-300/60 dark:border-red-500/40 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_10px_10px_-5px_rgba(0,0,0,0.04)] dark:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.6),0_10px_10px_-5px_rgba(0,0,0,0.3)]',
          textColor: 'text-red-800 dark:text-red-100',
          buttonColor: 'text-red-600 hover:text-red-800 dark:text-red-300 dark:hover:text-red-100'
        };
      case 'warning':
        return {
          container: 'backdrop-blur-xl bg-gradient-to-r from-yellow-50/95 to-orange-50/95 dark:from-yellow-950/90 dark:to-orange-950/90 border border-yellow-300/60 dark:border-yellow-500/40 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_10px_10px_-5px_rgba(0,0,0,0.04)] dark:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.6),0_10px_10px_-5px_rgba(0,0,0,0.3)]',
          textColor: 'text-yellow-800 dark:text-yellow-100',
          buttonColor: 'text-yellow-600 hover:text-yellow-800 dark:text-yellow-300 dark:hover:text-yellow-100'
        };
      case 'info':
      default:
        return {
          container: 'backdrop-blur-xl bg-gradient-to-r from-blue-50/95 to-cyan-50/95 dark:from-blue-950/90 dark:to-cyan-950/90 border border-blue-300/60 dark:border-blue-500/40 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_10px_10px_-5px_rgba(0,0,0,0.04)] dark:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.6),0_10px_10px_-5px_rgba(0,0,0,0.3)]',
          textColor: 'text-blue-800 dark:text-blue-100',
          buttonColor: 'text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100'
        };
    }
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        <AnimatePresence>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 100, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.9 }}
              transition={{ duration: 0.3, type: "spring", stiffness: 300, damping: 25 }}
              className={`flex items-center gap-3 p-4 rounded-lg min-w-[300px] max-w-[500px] ${getGlassmorphismStyles(toast.type).container}`}
            >
              {getIcon(toast.type)}
              <p className={`flex-1 text-sm font-medium ${getGlassmorphismStyles(toast.type).textColor}`}>
                {toast.message}
              </p>
              <button
                onClick={() => removeToast(toast.id)}
                className={`${getGlassmorphismStyles(toast.type).buttonColor} transition-colors duration-200`}
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}; 