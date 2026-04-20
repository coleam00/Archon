import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getConfig,
  getHealth,
  listCodebases,
  listProviders,
  addCodebase,
  getCodebaseInput,
  deleteCodebase,
  updateAssistantConfig,
  getCodebaseEnvVars,
  setCodebaseEnvVar,
  deleteCodebaseEnvVar,
} from '@/lib/api';
import type {
  SafeConfigResponse,
  CodebaseResponse,
  ProviderDefaults,
  ProviderInfo,
} from '@/lib/api';
import { healthStatusLabel, platformLabel, t } from '@/lib/i18n';

const selectClass =
  'h-9 rounded-md border border-border bg-surface-elevated text-text-primary px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface-elevated [&>option]:text-text-primary';

function SystemHealthSection({
  health,
  database,
}: {
  health:
    | {
        status: string;
        adapter: string;
        concurrency: { active: number; queuedTotal: number; maxConcurrent: number };
        runningWorkflows: number;
        version?: string;
      }
    | undefined;
  database: string | undefined;
}): React.ReactElement {
  const gitCommit = import.meta.env.VITE_GIT_COMMIT as string;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.systemHealth')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!health ? (
          <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted-foreground">{t('settings.status')}: </span>
              <Badge variant={health.status === 'ok' ? 'default' : 'destructive'}>
                {healthStatusLabel(health.status)}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">{t('settings.adapter')}: </span>
              <span className="font-medium">{health.adapter}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('settings.database')}: </span>
              <span className="font-medium">{database ?? t('settings.unknown')}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('settings.active')}: </span>
              <span className="font-medium">
                {health.concurrency.active}/{health.concurrency.maxConcurrent}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('settings.queued')}: </span>
              <span className="font-medium">{health.concurrency.queuedTotal}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('settings.workflows')}: </span>
              <span className="font-medium">{health.runningWorkflows}</span>
            </div>
            {health.version && (
              <div>
                <span className="text-muted-foreground">{t('settings.version')}: </span>
                <span className="font-medium">{health.version}</span>
              </div>
            )}
            {gitCommit && gitCommit !== 'unknown' && (
              <div>
                <span className="text-muted-foreground">{t('settings.commit')}: </span>
                <span className="font-medium font-mono">{gitCommit}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EnvVarsPanel({ codebaseId }: { codebaseId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: envVars } = useQuery({
    queryKey: ['codebaseEnvVars', codebaseId],
    queryFn: () => getCodebaseEnvVars(codebaseId),
  });

  const [mutationError, setMutationError] = useState<string | null>(null);

  const setMutation = useMutation({
    mutationFn: (data: { key: string; value: string }) => setCodebaseEnvVar(codebaseId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      if (editingKey) {
        setEditingKey(null);
        setEditValue('');
      } else {
        setNewKey('');
        setNewValue('');
      }
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteCodebaseEnvVar(codebaseId, key),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  function handleAdd(e: React.FormEvent): void {
    e.preventDefault();
    if (newKey.trim() && newValue !== '') {
      setMutation.mutate({ key: newKey.trim(), value: newValue });
    }
  }

  function handleEditSave(key: string): void {
    if (editValue !== '') {
      setMutation.mutate({ key, value: editValue });
    }
  }

  const keys = envVars ?? [];

  return (
    <div className="mt-2 pl-2 border-l border-border space-y-2">
      {mutationError && <div className="text-xs text-destructive">{mutationError}</div>}
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('settings.noEnvVars')}</div>
      ) : (
        <div className="space-y-1">
          {keys.map(key => (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-text-primary truncate flex-1">{key}</span>
                <span className="text-muted-foreground">= ------</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    if (editingKey === key) {
                      setEditingKey(null);
                      setEditValue('');
                    } else {
                      setEditingKey(key);
                      setEditValue('');
                    }
                  }}
                >
                  {editingKey === key ? t('common.cancel') : t('settings.edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    deleteMutation.mutate(key);
                  }}
                  disabled={deleteMutation.isPending}
                >
                  {t('common.remove')}
                </Button>
              </div>
              {editingKey === key && (
                <div className="flex gap-1 pl-2">
                  <Input
                    value={editValue}
                    onChange={e => {
                      setEditValue(e.target.value);
                    }}
                    placeholder={t('settings.newValue')}
                    className="flex-1 h-7 text-xs"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditSave(key);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      handleEditSave(key);
                    }}
                    disabled={setMutation.isPending}
                  >
                    {t('builder.save')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleAdd} className="flex gap-1">
        <Input
          value={newKey}
          onChange={e => {
            setNewKey(e.target.value);
          }}
          placeholder={t('settings.keyPlaceholder')}
          className="flex-1 h-7 text-xs font-mono"
        />
        <Input
          value={newValue}
          onChange={e => {
            setNewValue(e.target.value);
          }}
          placeholder={t('settings.valuePlaceholder')}
          className="flex-1 h-7 text-xs"
        />
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={setMutation.isPending}>
          {t('settings.add')}
        </Button>
      </form>
    </div>
  );
}

function ProjectsSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const [addValue, setAddValue] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [expandedEnvVars, setExpandedEnvVars] = useState<string | null>(null);

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  const addMutation = useMutation({
    mutationFn: (value: string) => addCodebase(getCodebaseInput(value)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
      setAddValue('');
      setShowAdd(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCodebase(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
    },
  });

  function handleAddSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (addValue.trim()) {
      addMutation.mutate(addValue.trim());
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.projects')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!codebases || codebases.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t('settings.noProjects')}</div>
        ) : (
          <div className="space-y-2">
            {codebases.map((cb: CodebaseResponse) => (
              <div key={cb.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{cb.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{cb.default_cwd}</div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        setExpandedEnvVars(expandedEnvVars === cb.id ? null : cb.id);
                      }}
                    >
                      {t('settings.envVars')} {expandedEnvVars === cb.id ? '\u25B2' : '\u25BC'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        deleteMutation.mutate(cb.id);
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      {t('common.remove')}
                    </Button>
                  </div>
                </div>
                {expandedEnvVars === cb.id && <EnvVarsPanel codebaseId={cb.id} />}
              </div>
            ))}
          </div>
        )}

        {showAdd ? (
          <form onSubmit={handleAddSubmit} className="mt-3 flex gap-2">
            <Input
              value={addValue}
              onChange={e => {
                setAddValue(e.target.value);
              }}
              placeholder={t('settings.githubUrlOrLocalPath')}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={addMutation.isPending}>
              {t('settings.add')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setAddValue('');
              }}
            >
              {t('common.cancel')}
            </Button>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setShowAdd(true);
            }}
          >
            {t('settings.addProject')}
          </Button>
        )}

        {addMutation.isError && (
          <div className="mt-2 text-sm text-destructive">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : t('settings.failedAddProject')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssistantConfigSection({ config }: { config: SafeConfigResponse }): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: listProviders,
    staleTime: 5 * 60 * 1000,
  });
  const [assistant, setAssistant] = useState<string>(config.assistant);
  const [assistantSettings, setAssistantSettings] = useState<Record<string, ProviderDefaults>>(
    config.assistants
  );
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const normalizedConfigSettings = JSON.stringify(config.assistants);
  const normalizedAssistantSettings = JSON.stringify(assistantSettings);
  const hasChanges =
    assistant !== config.assistant || normalizedAssistantSettings !== normalizedConfigSettings;

  useEffect(() => {
    setAssistant(config.assistant);
    setAssistantSettings(config.assistants);
  }, [config]);

  function getProviderSettings(providerId: string): ProviderDefaults {
    return assistantSettings[providerId] ?? {};
  }

  function updateProviderSettings(providerId: string, updates: ProviderDefaults): void {
    setAssistantSettings(current => ({
      ...current,
      [providerId]: {
        ...(current[providerId] ?? {}),
        ...updates,
      },
    }));
  }

  const allProviderEntries: ProviderInfo[] = [
    ...(providers ?? []),
    ...Object.keys(config.assistants)
      .filter(providerId => !(providers ?? []).some(provider => provider.id === providerId))
      .map(
        providerId =>
          ({
            id: providerId,
            displayName: providerId,
            capabilities: {},
            builtIn: false,
          }) satisfies ProviderInfo
      ),
  ];

  const mutation = useMutation({
    mutationFn: updateAssistantConfig,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setSaveMsg({ type: 'success', text: t('settings.saved') });
      setTimeout(() => {
        setSaveMsg(null);
      }, 3000);
    },
    onError: (err: Error) => {
      setSaveMsg({ type: 'error', text: err.message });
    },
  });

  function handleSave(): void {
    mutation.mutate({
      assistant,
      assistants: assistantSettings,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.assistantConfiguration')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm">
            <label htmlFor="default-assistant">{t('settings.defaultAssistant')}</label>
            <select
              id="default-assistant"
              value={assistant}
              onChange={e => {
                setAssistant(e.target.value);
              }}
              className={selectClass}
            >
              {allProviderEntries.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-4 border-t pt-4">
            {allProviderEntries.map(provider => {
              const providerSettings = getProviderSettings(provider.id);

              if (provider.id === 'claude') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">
                      {t('settings.builtInProviderSettings')}
                    </div>

                    <label htmlFor="claude-model">{t('settings.model')}</label>
                    <select
                      id="claude-model"
                      value={(providerSettings.model as string | undefined) ?? 'sonnet'}
                      onChange={e => {
                        updateProviderSettings('claude', { model: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="sonnet">sonnet</option>
                      <option value="opus">opus</option>
                      <option value="haiku">haiku</option>
                    </select>
                  </div>
                );
              }

              if (provider.id === 'codex') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">
                      {t('settings.builtInProviderSettings')}
                    </div>

                    <label htmlFor="codex-model">{t('settings.model')}</label>
                    <Input
                      id="codex-model"
                      value={(providerSettings.model as string | undefined) ?? ''}
                      onChange={e => {
                        updateProviderSettings('codex', { model: e.target.value });
                      }}
                      placeholder="gpt-5.3-codex"
                    />

                    <label htmlFor="reasoning">{t('settings.reasoningEffort')}</label>
                    <select
                      id="reasoning"
                      value={
                        (providerSettings.modelReasoningEffort as string | undefined) ?? 'medium'
                      }
                      onChange={e => {
                        updateProviderSettings('codex', {
                          modelReasoningEffort: e.target.value,
                        });
                      }}
                      className={selectClass}
                    >
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </select>

                    <label htmlFor="web-search">{t('settings.webSearch')}</label>
                    <select
                      id="web-search"
                      value={(providerSettings.webSearchMode as string | undefined) ?? 'disabled'}
                      onChange={e => {
                        updateProviderSettings('codex', { webSearchMode: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="disabled">disabled</option>
                      <option value="cached">cached</option>
                      <option value="live">live</option>
                    </select>
                  </div>
                );
              }

              return (
                <div key={provider.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="font-medium">{provider.displayName}</div>
                  <div className="mt-1 text-muted-foreground">
                    {t('settings.genericProviderSettings')}
                  </div>
                  {Object.keys(providerSettings).length > 0 && (
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(providerSettings, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? t('settings.saving') : t('settings.saveChanges')}
            </Button>
            {saveMsg && (
              <span
                className={`text-sm ${saveMsg.type === 'success' ? 'text-green-500' : 'text-destructive'}`}
              >
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatformConnectionsSection({
  adapter,
}: {
  adapter: string | undefined;
}): React.ReactElement {
  const platforms = [
    { name: 'Web', connected: adapter === 'web' },
    { name: 'Slack', connected: false },
    { name: 'Telegram', connected: false },
    { name: 'Discord', connected: false },
    { name: 'GitHub', connected: false },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.platformConnections')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {platforms.map(p => (
            <div key={p.name} className="flex items-center justify-between text-sm">
              <span>{platformLabel(p.name)}</span>
              <Badge variant={p.connected ? 'default' : 'secondary'}>
                {p.connected ? t('common.connected') : t('settings.notConfigured')}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConcurrencySection({
  health,
}: {
  health: { concurrency: { active: number; maxConcurrent: number } } | undefined;
}): React.ReactElement {
  const active = health?.concurrency.active ?? 0;
  const max = health?.concurrency.maxConcurrent ?? 1;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.concurrency')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${String(pct)}%` }}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {active} / {max}
            {t('settings.concurrentConversations')}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage(): React.ReactElement {
  const {
    data: configData,
    isLoading: configLoading,
    error: configError,
  } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const {
    data: health,
    isLoading: healthLoading,
    error: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  const isLoading = configLoading || healthLoading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title={t('settings.title')} />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {(configError || healthError) && (
            <div className="text-sm text-destructive">
              {t('settings.loadFailedPrefix')}{' '}
              {((): string => {
                const err = configError ?? healthError;
                return err instanceof Error ? err.message : t('settings.unknown');
              })()}
              . {t('settings.loadFailedSuffix')}
            </div>
          )}

          {isLoading && (
            <div className="text-sm text-muted-foreground">{t('settings.loadingSettings')}</div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SystemHealthSection health={health} database={configData?.database} />
            <ConcurrencySection health={health} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {configData && <AssistantConfigSection config={configData.config} />}
            <PlatformConnectionsSection adapter={health?.adapter} />
          </div>

          <ProjectsSection />
        </div>
      </div>
    </div>
  );
}
