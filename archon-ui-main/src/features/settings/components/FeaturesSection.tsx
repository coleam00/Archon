import React, { useState, useEffect } from 'react';
import { Moon, Sun, FileText, Layout, Bot, Settings, Palette, Flame, Monitor } from 'lucide-react';
import { Switch } from '@/features/ui/primitives/switch';
import { Card } from '@/features/ui/primitives/card';
import { useTheme } from '../../../contexts/ThemeContext';
import { credentialsService } from '../../../services/credentialsService';
import { useToast } from '../../shared/hooks/useToast';
import { serverHealthService } from '../../../services/serverHealthService';
import { useSettings } from '../../../contexts/SettingsContext';

export const FeaturesSection = () => {
  const {
    theme,
    setTheme
  } = useTheme();
  const { showToast } = useToast();
  const { styleGuideEnabled, setStyleGuideEnabled: setStyleGuideContext } = useSettings();
  const isDarkMode = theme === 'dark';
  const [projectsEnabled, setProjectsEnabled] = useState(true);
  const [styleGuideEnabledLocal, setStyleGuideEnabledLocal] = useState(styleGuideEnabled);

  const [agUILibraryEnabled, setAgUILibraryEnabled] = useState(false);
  const [agentsEnabled, setAgentsEnabled] = useState(false);

  const [logfireEnabled, setLogfireEnabled] = useState(false);
  const [disconnectScreenEnabled, setDisconnectScreenEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [projectsSchemaValid, setProjectsSchemaValid] = useState(true);
  const [projectsSchemaError, setProjectsSchemaError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    setStyleGuideEnabledLocal(styleGuideEnabled);
  }, [styleGuideEnabled]);

  const loadSettings = async () => {
    try {
      setLoading(true);

      const [logfireResponse, projectsResponse, projectsHealthResponse, disconnectScreenRes] = await Promise.all([
        credentialsService.getCredential('LOGFIRE_ENABLED').catch(() => ({ value: undefined })),
        credentialsService.getCredential('PROJECTS_ENABLED').catch(() => ({ value: undefined })),
        fetch(`${credentialsService['baseUrl']}/api/projects/health`).catch(() => null),
        credentialsService.getCredential('DISCONNECT_SCREEN_ENABLED').catch(() => ({ value: 'true' }))
      ]);

      if (logfireResponse.value !== undefined) {
        setLogfireEnabled(logfireResponse.value === 'true');
      } else {
        setLogfireEnabled(false);
      }

      setDisconnectScreenEnabled(disconnectScreenRes.value === 'true');

      console.log('🔍 Projects health response:', {
        response: projectsHealthResponse,
        ok: projectsHealthResponse?.ok,
        status: projectsHealthResponse?.status,
        url: `${credentialsService['baseUrl']}/api/projects/health`
      });

      if (projectsHealthResponse && projectsHealthResponse.ok) {
        const healthData = await projectsHealthResponse.json();
        console.log('🔍 Projects health data:', healthData);

        const schemaValid = healthData.schema?.valid === true;
        setProjectsSchemaValid(schemaValid);

        if (!schemaValid) {
          setProjectsSchemaError(
            'Projects table not detected. Please ensure you have installed the archon_tasks.sql structure to your database and restart the server.'
          );
        } else {
          setProjectsSchemaError(null);
        }
      } else {
        console.log('🔍 Projects health check failed');
        setProjectsSchemaValid(false);
        setProjectsSchemaError(
          'Unable to verify projects schema. Please ensure the backend is running and database is accessible.'
        );
      }

      if (projectsResponse.value !== undefined) {
        setProjectsEnabled(projectsResponse.value === 'true');
      } else {
        setProjectsEnabled(true);
      }

    } catch (error) {
      console.error('Failed to load settings:', error);
      setLogfireEnabled(false);
      setProjectsEnabled(true);
      setDisconnectScreenEnabled(true);
      setProjectsSchemaValid(false);
      setProjectsSchemaError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleProjectsToggle = async (checked: boolean) => {
    if (loading) return;

    try {
      setLoading(true);
      setProjectsEnabled(checked);

      await credentialsService.createCredential({
        key: 'PROJECTS_ENABLED',
        value: checked.toString(),
        is_encrypted: false,
        category: 'features',
        description: 'Enable or disable Projects and Tasks functionality'
      });

      showToast(
        checked ? 'Projects Enabled Successfully!' : 'Projects Now Disabled',
        checked ? 'success' : 'warning'
      );
    } catch (error) {
      console.error('Failed to update projects setting:', error);
      setProjectsEnabled(!checked);
      showToast('Failed to update Projects setting', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogfireToggle = async (checked: boolean) => {
    if (loading) return;

    try {
      setLoading(true);
      setLogfireEnabled(checked);

      await credentialsService.createCredential({
        key: 'LOGFIRE_ENABLED',
        value: checked.toString(),
        is_encrypted: false,
        category: 'monitoring',
        description: 'Enable or disable Pydantic Logfire logging and observability'
      });

      showToast(
        checked ? 'Logfire Enabled Successfully!' : 'Logfire Now Disabled',
        checked ? 'success' : 'warning'
      );
    } catch (error) {
      console.error('Failed to update logfire setting:', error);
      setLogfireEnabled(!checked);
      showToast('Failed to update Logfire setting', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleThemeToggle = (checked: boolean) => {
    setTheme(checked ? 'dark' : 'light');
  };

  const handleDisconnectScreenToggle = async (checked: boolean) => {
    if (loading) return;

    try {
      setLoading(true);
      setDisconnectScreenEnabled(checked);

      await serverHealthService.updateSettings(checked);

      showToast(
        checked ? 'Disconnect Screen Enabled' : 'Disconnect Screen Disabled',
        checked ? 'success' : 'warning'
      );
    } catch (error) {
      console.error('Failed to update disconnect screen setting:', error);
      setDisconnectScreenEnabled(!checked);
      showToast('Failed to update disconnect screen setting', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleStyleGuideToggle = async (checked: boolean) => {
    if (loading) return;

    try {
      setLoading(true);
      setStyleGuideEnabledLocal(checked);

      await setStyleGuideContext(checked);

      showToast(
        checked ? 'Style Guide Enabled' : 'Style Guide Disabled',
        checked ? 'success' : 'warning'
      );
    } catch (error) {
      console.error('Failed to update style guide setting:', error);
      setStyleGuideEnabledLocal(!checked);
      showToast('Failed to update style guide setting', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Theme Toggle */}
          <Card glowColor="purple" glowType="inner" glowSize="sm">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">
                  Dark Mode
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Switch between light and dark themes
                </p>
              </div>
              <div className="flex-shrink-0">
                <Switch
                  size="lg"
                  checked={isDarkMode}
                  onCheckedChange={handleThemeToggle}
                  color="purple"
                  iconOn={<Moon className="w-5 h-5" />}
                  iconOff={<Sun className="w-5 h-5" />}
                />
              </div>
            </div>
          </Card>

          {/* Projects Toggle */}
          <Card glowColor="blue" glowType="inner" glowSize="sm">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">
                  Projects
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Enable Projects and Tasks functionality
                </p>
                {!projectsSchemaValid && projectsSchemaError && (
                  <p className="text-xs text-red-500 dark:text-red-400 mt-1">
                    ⚠️ {projectsSchemaError}
                  </p>
                )}
              </div>
              <div className="flex-shrink-0">
                <Switch
                  size="lg"
                  checked={projectsEnabled}
                  onCheckedChange={handleProjectsToggle}
                  color="blue"
                  icon={<FileText className="w-5 h-5" />}
                  disabled={loading || !projectsSchemaValid}
                />
              </div>
            </div>
          </Card>

          {/* Style Guide Toggle */}
          <Card glowColor="cyan" glowType="inner" glowSize="sm">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">
                  Style Guide
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Show UI style guide and components in navigation
                </p>
              </div>
              <div className="flex-shrink-0">
                <Switch
                  size="lg"
                  checked={styleGuideEnabledLocal}
                  onCheckedChange={handleStyleGuideToggle}
                  color="cyan"
                  icon={<Palette className="w-5 h-5" />}
                  disabled={loading}
                />
              </div>
            </div>
          </Card>

          {/* Pydantic Logfire Toggle */}
          <Card glowColor="orange" glowType="inner" glowSize="sm">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">
                  Pydantic Logfire
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Structured logging and observability platform
                </p>
              </div>
              <div className="flex-shrink-0">
                <Switch
                  size="lg"
                  checked={logfireEnabled}
                  onCheckedChange={handleLogfireToggle}
                  color="orange"
                  icon={<Flame className="w-5 h-5" />}
                  disabled={loading}
                />
              </div>
            </div>
          </Card>

          {/* Disconnect Screen Toggle */}
          <Card glowColor="green" glowType="inner" glowSize="sm">
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">
                  Disconnect Screen
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Show disconnect screen when server disconnects
                </p>
              </div>
              <div className="flex-shrink-0">
                <Switch
                  size="lg"
                  checked={disconnectScreenEnabled}
                  onCheckedChange={handleDisconnectScreenToggle}
                  color="green"
                  icon={<Monitor className="w-5 h-5" />}
                  disabled={loading}
                />
              </div>
            </div>
          </Card>
        </div>
    </>
  );
};
