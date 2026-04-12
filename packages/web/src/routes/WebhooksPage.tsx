import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Pencil, Plus, Trash2, Webhook } from 'lucide-react';
import {
  type CreateWebhookRuleBody,
  type UpdateWebhookRuleBody,
  createWebhookRule,
  deleteWebhookRule,
  getWebhookRuleOptions,
  listWebhookRules,
  updateWebhookRule,
} from '@/lib/api';
import type { WebhookRuleResponse, WebhookRulesOptionsResponse } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const selectClass =
  'h-9 rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface-elevated [&>option]:text-text-primary';

const inputClass =
  'h-9 rounded-md border border-border bg-surface-elevated px-3 text-sm text-text-primary placeholder:text-text-secondary/70 focus:outline-none focus:ring-1 focus:ring-ring';

interface RuleFormState {
  codebaseId: string;
  workflowName: string;
  urlSlug: string;
  enabled: boolean;
}

function buildInitialForm(options: WebhookRulesOptionsResponse | undefined): RuleFormState {
  const firstCodebase = options?.codebases[0];
  const firstWorkflow = firstCodebase
    ? options?.workflowsByCodebase.find(entry => entry.codebaseId === firstCodebase.id)
        ?.workflows[0]
    : undefined;

  return {
    codebaseId: firstCodebase?.id ?? '',
    workflowName: firstWorkflow?.name ?? '',
    urlSlug: '',
    enabled: true,
  };
}

export function WebhooksPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<WebhookRuleResponse | null>(null);
  const [formState, setFormState] = useState<RuleFormState>(buildInitialForm(undefined));
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { data: rules, isLoading: rulesLoading } = useQuery({
    queryKey: ['webhookRules'],
    queryFn: listWebhookRules,
  });

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ['webhookRuleOptions'],
    queryFn: getWebhookRuleOptions,
  });

  const selectedWorkflows = useMemo(() => {
    return (
      options?.workflowsByCodebase.find(entry => entry.codebaseId === formState.codebaseId)
        ?.workflows ?? []
    );
  }, [formState.codebaseId, options]);

  const webhookPreviewUrl = useMemo(() => {
    const slug = formState.urlSlug.trim();
    return slug
      ? `${window.location.origin}/webhooks/${slug}`
      : `${window.location.origin}/webhooks/<slug>`;
  }, [formState.urlSlug]);

  const saveMutation = useMutation({
    mutationFn: async (payload: RuleFormState) => {
      const normalizedPayload = {
        codebaseId: payload.codebaseId,
        workflowName: payload.workflowName,
        urlSlug: payload.urlSlug.trim(),
        enabled: payload.enabled,
      };

      if (editingRule) {
        const updatePayload: UpdateWebhookRuleBody = normalizedPayload;
        return updateWebhookRule(editingRule.id, updatePayload);
      }

      const createPayload: CreateWebhookRuleBody = normalizedPayload;
      return createWebhookRule(createPayload);
    },
    onSuccess: () => {
      setDialogOpen(false);
      setEditingRule(null);
      setMutationError(null);
      void queryClient.invalidateQueries({ queryKey: ['webhookRules'] });
    },
    onError: error => {
      setMutationError(error instanceof Error ? error.message : 'Failed to save webhook rule');
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateWebhookRule(id, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhookRules'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteWebhookRule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhookRules'] });
    },
  });

  function resetForm(): void {
    setFormState(buildInitialForm(options));
  }

  function openCreateDialog(): void {
    setEditingRule(null);
    setMutationError(null);
    setFormState(buildInitialForm(options));
    setDialogOpen(true);
  }

  function openEditDialog(rule: WebhookRuleResponse): void {
    setEditingRule(rule);
    setMutationError(null);
    setFormState({
      codebaseId: rule.codebaseId,
      workflowName: rule.workflowName,
      urlSlug: rule.urlSlug,
      enabled: rule.enabled,
    });
    setDialogOpen(true);
  }

  function handleCodebaseChange(codebaseId: string): void {
    const workflows =
      options?.workflowsByCodebase.find(entry => entry.codebaseId === codebaseId)?.workflows ?? [];

    setFormState(current => ({
      ...current,
      codebaseId,
      workflowName: workflows.some(workflow => workflow.name === current.workflowName)
        ? current.workflowName
        : (workflows[0]?.name ?? ''),
    }));
  }

  function handleDelete(rule: WebhookRuleResponse): void {
    const confirmed = window.confirm(
      `Delete webhook rule for ${rule.codebaseName} (${rule.urlSlug})?`
    );
    if (!confirmed) return;
    deleteMutation.mutate(rule.id);
  }

  const isLoading = rulesLoading || optionsLoading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="flex items-center gap-2">
          <Webhook className="size-5 text-primary" />
          <h1 className="text-lg font-semibold text-text-primary">Webhooks</h1>
        </div>
        <Button onClick={openCreateDialog} className="inline-flex items-center gap-1.5">
          <Plus className="size-4" />
          New Webhook
        </Button>
      </div>

      <div className="px-4 pb-4">
        <Card>
          <CardHeader>
            <CardTitle>Webhook Rules</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading webhook rules…</div>
            ) : !rules || rules.length === 0 ? (
              <div className="text-sm text-muted-foreground">No webhook rules configured yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-text-secondary">
                      <th className="px-3 py-2 font-medium">Project</th>
                      <th className="px-3 py-2 font-medium">Workflow</th>
                      <th className="px-3 py-2 font-medium">URL</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map(rule => (
                      <tr key={rule.id} className="border-b border-border/60 last:border-b-0">
                        <td className="px-3 py-3 text-text-primary">{rule.codebaseName}</td>
                        <td className="px-3 py-3 text-text-primary">{rule.workflowName}</td>
                        <td className="px-3 py-3 text-text-secondary">
                          <div className="inline-flex items-center gap-2">
                            <Link2 className="size-3.5" />
                            <code className="rounded bg-surface-elevated px-2 py-1 text-xs">
                              /webhooks/{rule.urlSlug}
                            </code>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={
                              rule.enabled
                                ? 'inline-flex rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-300'
                                : 'inline-flex rounded-full bg-zinc-500/10 px-2 py-1 text-xs font-medium text-zinc-400'
                            }
                          >
                            {rule.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                openEditDialog(rule);
                              }}
                            >
                              <Pencil className="mr-1 size-3.5" />
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled });
                              }}
                            >
                              {rule.enabled ? 'Disable' : 'Enable'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                handleDelete(rule);
                              }}
                            >
                              <Trash2 className="mr-1 size-3.5" />
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={open => {
          setDialogOpen(open);
          if (!open) {
            setEditingRule(null);
            setMutationError(null);
            resetForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingRule ? 'Edit webhook rule' : 'Create webhook rule'}</DialogTitle>
            <DialogDescription>
              Choose a project, choose a workflow, and give the webhook a URL slug.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm text-text-primary">
              <span>Project</span>
              <select
                className={selectClass}
                value={formState.codebaseId}
                onChange={event => {
                  handleCodebaseChange(event.target.value);
                }}
              >
                {options?.codebases.map(codebase => (
                  <option key={codebase.id} value={codebase.id}>
                    {codebase.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5 text-sm text-text-primary">
              <span>Workflow</span>
              <select
                className={selectClass}
                value={formState.workflowName}
                onChange={event => {
                  setFormState(current => ({ ...current, workflowName: event.target.value }));
                }}
              >
                {selectedWorkflows.map(workflow => (
                  <option key={workflow.name} value={workflow.name}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5 text-sm text-text-primary">
              <span>URL slug</span>
              <input
                className={inputClass}
                value={formState.urlSlug}
                onChange={event => {
                  setFormState(current => ({ ...current, urlSlug: event.target.value }));
                }}
                placeholder="my-project-hook"
              />
              <span className="text-xs text-text-secondary">
                Full URL: <code>{webhookPreviewUrl}</code>
              </span>
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={formState.enabled}
                onChange={event => {
                  setFormState(current => ({ ...current, enabled: event.target.checked }));
                }}
              />
              Enabled
            </label>

            {mutationError ? <p className="text-sm text-destructive">{mutationError}</p> : null}
            {!selectedWorkflows.length ? (
              <p className="text-sm text-amber-300">
                No workflows are available for the selected project.
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                setEditingRule(null);
                setMutationError(null);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                saveMutation.mutate(formState);
              }}
              disabled={
                saveMutation.isPending ||
                !formState.codebaseId ||
                !formState.workflowName ||
                !formState.urlSlug.trim()
              }
            >
              {saveMutation.isPending ? 'Saving…' : editingRule ? 'Save Changes' : 'Create Webhook'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
