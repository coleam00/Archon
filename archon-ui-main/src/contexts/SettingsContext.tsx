import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { credentialsService } from '../services/credentialsService';

interface SettingsContextType {
  projectsEnabled: boolean;
  setProjectsEnabled: (enabled: boolean) => Promise<void>;
  styleGuideEnabled: boolean;
  setStyleGuideEnabled: (enabled: boolean) => Promise<void>;
  loading: boolean;
  refreshSettings: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

interface SettingsProviderProps {
  children: ReactNode;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children }) => {
  const [projectsEnabled, setProjectsEnabledState] = useState(true);
  const [styleGuideEnabled, setStyleGuideEnabledState] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadSettings = async () => {
    try {
      setLoading(true);

      // Load Projects and Style Guide settings
      const [projectsResponse, styleGuideResponse] = await Promise.all([
        credentialsService.getCredential('PROJECTS_ENABLED').catch(() => ({ value: undefined })),
        credentialsService.getCredential('STYLE_GUIDE_ENABLED').catch(() => ({ value: undefined }))
      ]);

      if (projectsResponse.value !== undefined) {
        setProjectsEnabledState(projectsResponse.value === 'true');
      } else {
        setProjectsEnabledState(true); // Default to true
      }

      if (styleGuideResponse.value !== undefined) {
        setStyleGuideEnabledState(styleGuideResponse.value === 'true');
      } else {
        setStyleGuideEnabledState(false); // Default to false
      }

    } catch (error) {
      console.error('Failed to load settings:', error);
      setProjectsEnabledState(true);
      setStyleGuideEnabledState(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const setProjectsEnabled = async (enabled: boolean) => {
    try {
      // Update local state immediately
      setProjectsEnabledState(enabled);

      // Save to backend
      await credentialsService.createCredential({
        key: 'PROJECTS_ENABLED',
        value: enabled.toString(),
        is_encrypted: false,
        category: 'features',
        description: 'Enable or disable Projects and Tasks functionality'
      });
    } catch (error) {
      console.error('Failed to update projects setting:', error);
      // Revert on error
      setProjectsEnabledState(!enabled);
      throw error;
    }
  };

  const setStyleGuideEnabled = async (enabled: boolean) => {
    try {
      // Update local state immediately
      setStyleGuideEnabledState(enabled);

      // Save to backend
      await credentialsService.createCredential({
        key: 'STYLE_GUIDE_ENABLED',
        value: enabled.toString(),
        is_encrypted: false,
        category: 'features',
        description: 'Show UI style guide and components in navigation'
      });
    } catch (error) {
      console.error('Failed to update style guide setting:', error);
      // Revert on error
      setStyleGuideEnabledState(!enabled);
      throw error;
    }
  };

  const refreshSettings = async () => {
    await loadSettings();
  };

  const value: SettingsContextType = {
    projectsEnabled,
    setProjectsEnabled,
    styleGuideEnabled,
    setStyleGuideEnabled,
    loading,
    refreshSettings
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}; 