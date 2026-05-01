import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  FileCode2,
  Link2,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteSkill,
  deleteSkillFile,
  getSkill,
  saveSkill,
  uploadSkillFile,
  writeSkillFileText,
  type SkillDetail,
  type SkillSource,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/skill-utils';
import { SkillFileTree } from './SkillFileTree';
import { SkillFileEditor } from './SkillFileEditor';
import { ConfirmDialog } from './ConfirmDialog';

interface SkillEditorProps {
  cwd: string | undefined;
  name: string | null;
  source: SkillSource | null;
  onDeleted: () => void;
}

interface DraftState {
  name: string;
  description: string;
  body: string;
  argumentHint: string;
  allowedTools: string[];
  disableModelInvocation: boolean;
  /** Custom YAML for keys not represented in the structured form. */
  extrasYaml: string;
}

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'argument-hint',
  'allowed-tools',
  'disable-model-invocation',
]);

function detailToDraft(detail: SkillDetail): DraftState {
  const fm = detail.frontmatter;
  const allowed = Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'].map(v => String(v)) : [];
  const argHint = typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : '';
  const disableMI =
    typeof fm['disable-model-invocation'] === 'boolean' ? fm['disable-model-invocation'] : false;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v;
  }
  return {
    name: typeof fm.name === 'string' ? fm.name : detail.name,
    description: typeof fm.description === 'string' ? fm.description : '',
    body: detail.body,
    argumentHint: argHint,
    allowedTools: allowed,
    disableModelInvocation: disableMI,
    extrasYaml: stringifyExtras(extras),
  };
}

function stringifyExtras(extras: Record<string, unknown>): string {
  if (Object.keys(extras).length === 0) return '';
  // Bun.YAML is server-side; use JSON as a fallback that humans can read/edit.
  return JSON.stringify(extras, null, 2);
}

function parseExtras(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Custom fields must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function draftToFrontmatter(
  draft: DraftState
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const extras = parseExtras(draft.extrasYaml);
  if (!extras.ok) return extras;
  const fm: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    ...extras.value,
  };
  if (draft.argumentHint.trim()) fm['argument-hint'] = draft.argumentHint;
  if (draft.allowedTools.length > 0) fm['allowed-tools'] = draft.allowedTools;
  if (draft.disableModelInvocation) fm['disable-model-invocation'] = true;
  return { ok: true, value: fm };
}

export function SkillEditor({
  cwd,
  name,
  source,
  onDeleted,
}: SkillEditorProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [fileSheetPath, setFileSheetPath] = useState<string | null>(null);
  const [pendingUploadName, setPendingUploadName] = useState<string>('');
  const [newToolInput, setNewToolInput] = useState('');
  const [pathCopied, setPathCopied] = useState(false);

  const detailQuery = useQuery({
    enabled: !!name && !!source,
    queryKey: ['skill', name, source, cwd ?? null],
    queryFn: () => getSkill(name ?? '', source ?? 'global', cwd),
  });

  // Reset draft whenever the loaded detail changes (different skill or refetch).
  useEffect(() => {
    if (detailQuery.data) {
      setDraft(detailToDraft(detailQuery.data));
      setSaveError(null);
    } else if (!name) {
      setDraft(null);
    }
  }, [detailQuery.data, name]);

  const detail = detailQuery.data;
  const dirty = useMemo(() => {
    if (!detail || !draft) return false;
    const original = detailToDraft(detail);
    return JSON.stringify(original) !== JSON.stringify(draft);
  }, [detail, draft]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!detail || !draft || !source) throw new Error('Nothing to save');
      const fm = draftToFrontmatter(draft);
      if (!fm.ok) throw new Error(fm.error);
      return saveSkill(detail.name, {
        source,
        cwd,
        frontmatter: fm.value,
        body: draft.body,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['skill', name, source, cwd ?? null] });
    },
    onError: err => {
      setSaveError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!name || !source) throw new Error('No skill selected');
      return deleteSkill(name, source, cwd);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      onDeleted();
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (path: string) => {
      if (!name || !source) throw new Error('No skill selected');
      return deleteSkillFile(name, source, path, cwd);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill', name, source, cwd ?? null] });
    },
  });

  const newFileMutation = useMutation({
    mutationFn: (input: { path: string; content: string }) => {
      if (!name || !source) throw new Error('No skill selected');
      return writeSkillFileText(name, source, input.path, input.content, cwd);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill', name, source, cwd ?? null] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (input: { path: string; file: File }) => {
      if (!name || !source) throw new Error('No skill selected');
      return uploadSkillFile(name, source, input.path, input.file, cwd);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill', name, source, cwd ?? null] });
    },
  });

  // ---------------------------- Empty state ----------------------------

  if (!name || !source) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bridges-bg">
        <div className="max-w-sm text-center">
          <div className="mb-1.5 text-[15px] font-medium text-bridges-fg1">No skill selected</div>
          <div className="text-[13px] leading-snug text-bridges-fg2">
            Pick a skill from the list, or create a new one to start editing its frontmatter and
            instructions.
          </div>
        </div>
      </div>
    );
  }

  if (detailQuery.isLoading || !detail || !draft) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bridges-bg text-[13px] text-bridges-fg3">
        Loading skill…
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bridges-bg p-6 text-center text-[13px] text-bridges-tint-danger-fg">
        Failed to load skill: {detailQuery.error.message}
      </div>
    );
  }

  // ---------------------------- Editor ----------------------------

  const onAddTool = (): void => {
    const v = newToolInput.trim();
    if (!v) return;
    setDraft(d => (d ? { ...d, allowedTools: [...d.allowedTools, v] } : d));
    setNewToolInput('');
  };
  const onRemoveTool = (i: number): void => {
    setDraft(d => (d ? { ...d, allowedTools: d.allowedTools.filter((_, idx) => idx !== i) } : d));
  };

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(detail.path);
      setPathCopied(true);
      setTimeout(() => {
        setPathCopied(false);
      }, 1200);
    } catch {
      // clipboard unavailable — silently ignore
    }
  };

  const handleNewFile = (): void => {
    const path = window.prompt(
      'New file path inside this skill (e.g. scripts/hello.sh, references/notes.md):',
      'scripts/'
    );
    if (!path) return;
    if (path === 'SKILL.md') {
      window.alert('SKILL.md is the main file — edit it via the Instructions section above.');
      return;
    }
    newFileMutation.mutate({ path, content: '' });
    setFileSheetPath(path);
  };

  const handleUpload = (file: File): void => {
    const targetPath = pendingUploadName.trim() || file.name;
    uploadMutation.mutate({ path: targetPath, file });
    setPendingUploadName('');
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bridges-bg">
      {/* Top bar */}
      <div className="flex h-[46px] shrink-0 items-center gap-3 border-b border-bridges-border-subtle bg-bridges-surface px-5">
        <span className="text-[13px] text-bridges-fg3">Skills</span>
        <span className="text-bridges-border-strong">/</span>
        <span className="font-mono text-[13px] font-medium text-bridges-fg1">{detail.name}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-bridges-fg3">Edited {relativeTime(detail.mtime)}</span>
          <span className="h-3.5 w-px bg-bridges-border" />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px] text-bridges-tint-danger-fg hover:bg-bridges-tint-danger-bg hover:text-bridges-tint-danger-fg"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
          <Button
            size="sm"
            className="h-7 px-3 text-[12px]"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => {
              setSaveError(null);
              saveMutation.mutate();
            }}
          >
            {saveMutation.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </Button>
        </div>
      </div>

      {/* Scroll body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-20 pt-8">
          {detail.parseError && (
            <div className="mb-6 flex items-start gap-2 rounded-md border border-bridges-tint-danger-fg/30 bg-bridges-tint-danger-bg px-3 py-2 text-[12.5px] leading-snug text-bridges-tint-danger-fg">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <div className="font-medium">Frontmatter could not be parsed</div>
                <div>{detail.parseError}</div>
                <div className="mt-1 text-bridges-tint-danger-fg/80">
                  The body is shown raw below. Fix the YAML and save to recover.
                </div>
              </div>
            </div>
          )}

          {saveError && (
            <div className="mb-6 rounded-md border border-bridges-tint-danger-fg/30 bg-bridges-tint-danger-bg px-3 py-2 text-[12.5px] text-bridges-tint-danger-fg">
              {saveError}
            </div>
          )}

          {/* Title block */}
          <div className="mb-8">
            <div className="mb-3 flex items-center gap-2">
              <SourcePill source={detail.source} />
              {detail.isSymlink && <SymlinkPill realPath={detail.realPath} />}
              <span className="ml-auto font-mono text-[11px] text-bridges-fg3">{detail.name}</span>
            </div>
            <input
              type="text"
              value={draft.name}
              readOnly
              title="The directory name is fixed — frontmatter.name must match it."
              className="mb-1.5 w-full cursor-not-allowed border-0 bg-transparent p-0 text-[28px] font-semibold leading-tight tracking-tight text-bridges-fg1 outline-none"
            />
            <textarea
              value={draft.description}
              onChange={e => {
                setDraft(d => (d ? { ...d, description: e.target.value } : d));
              }}
              rows={2}
              placeholder="One-line description that tells Claude when to use this skill."
              className="w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-snug text-bridges-fg2 outline-none placeholder:text-bridges-fg-placeholder"
            />
          </div>

          {/* Meta strip */}
          <div className="mb-8 grid grid-cols-1 gap-4 rounded-md border border-bridges-border bg-bridges-surface p-4 sm:grid-cols-2">
            <MetaField label="Source" value={detail.source === 'global' ? 'Global' : 'Project'} />
            <MetaField
              label="Path"
              value={
                <button
                  type="button"
                  onClick={() => {
                    void copyPath();
                  }}
                  className="flex items-center gap-1.5 truncate text-left font-mono text-[12.5px] text-bridges-fg1 hover:underline"
                  title={detail.path}
                >
                  <span className="truncate">{detail.path}</span>
                  {pathCopied ? (
                    <Check className="h-3 w-3 shrink-0 text-bridges-success" />
                  ) : (
                    <Copy className="h-3 w-3 shrink-0 text-bridges-fg3" />
                  )}
                </button>
              }
            />
            <MetaField
              label="Symlinked target"
              value={
                detail.isSymlink && detail.realPath ? (
                  <span
                    className="truncate font-mono text-[12.5px] text-bridges-fg1"
                    title={detail.realPath}
                  >
                    → {detail.realPath}
                  </span>
                ) : (
                  <span className="text-bridges-fg3">—</span>
                )
              }
            />
            <MetaField
              label="Files"
              value={
                <div className="flex items-center gap-2 text-[12.5px] text-bridges-fg2">
                  {detail.hasScripts && <span className="font-mono">scripts/</span>}
                  {detail.hasReferences && <span className="font-mono">references/</span>}
                  {detail.hasAssets && <span className="font-mono">assets/</span>}
                  {!detail.hasScripts && !detail.hasReferences && !detail.hasAssets && (
                    <span className="text-bridges-fg3">SKILL.md only</span>
                  )}
                </div>
              }
            />
          </div>

          {/* Allowed tools */}
          <Section
            icon={<Bell className="h-3.5 w-3.5" />}
            title="Allowed tools"
            subtitle="Frontmatter `allowed-tools` — restricts which Claude tools this skill may use."
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.allowedTools.map((t, i) => (
                <span
                  key={`${t}-${i.toString()}`}
                  className="inline-flex items-center gap-1.5 rounded bg-bridges-tag-violet-bg px-2 py-0.5 font-mono text-[12px] text-bridges-tag-violet-fg"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => {
                      onRemoveTool(i);
                    }}
                    className="text-bridges-tag-violet-fg/60 hover:text-bridges-tag-violet-fg"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={newToolInput}
                onChange={e => {
                  setNewToolInput(e.target.value);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onAddTool();
                  }
                }}
                placeholder="Add tool, e.g. Bash(git:*)"
                className="rounded border border-dashed border-bridges-border-strong bg-transparent px-2 py-1 font-mono text-[12px] text-bridges-fg1 placeholder:text-bridges-fg3 focus:outline-none"
              />
              {newToolInput && (
                <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={onAddTool}>
                  <Plus className="mr-1 h-3 w-3" /> Add
                </Button>
              )}
            </div>
          </Section>

          {/* Other frontmatter */}
          <Section
            icon={<FileCode2 className="h-3.5 w-3.5" />}
            title="Other frontmatter"
            subtitle="Optional fields the Claude SDK and other tooling may read."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldBlock label="argument-hint">
                <input
                  type="text"
                  value={draft.argumentHint}
                  onChange={e => {
                    setDraft(d => (d ? { ...d, argumentHint: e.target.value } : d));
                  }}
                  placeholder="[arg]"
                  className="w-full rounded-md border border-bridges-border bg-bridges-surface px-3 py-1.5 font-mono text-[12.5px] focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </FieldBlock>
              <FieldBlock label="disable-model-invocation">
                <label className="flex h-[34px] items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-3 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={draft.disableModelInvocation}
                    onChange={e => {
                      const v = e.target.checked;
                      setDraft(d => (d ? { ...d, disableModelInvocation: v } : d));
                    }}
                  />
                  <span className="text-bridges-fg2">
                    {draft.disableModelInvocation
                      ? 'Off — Claude won’t auto-trigger'
                      : 'On — Claude can invoke'}
                  </span>
                </label>
              </FieldBlock>
            </div>
            <FieldBlock
              label="Custom fields (JSON)"
              hint="Anything else from the YAML frontmatter is round-tripped here. Edit as JSON; saved as YAML."
            >
              <textarea
                value={draft.extrasYaml}
                onChange={e => {
                  setDraft(d => (d ? { ...d, extrasYaml: e.target.value } : d));
                }}
                rows={4}
                spellCheck={false}
                placeholder='{ "version": "1.0" }'
                className="w-full resize-y rounded-md border border-bridges-border bg-bridges-surface px-3 py-2 font-mono text-[12px] focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </FieldBlock>
          </Section>

          {/* Instructions */}
          <Section
            icon={<FileCode2 className="h-3.5 w-3.5" />}
            title="Instructions"
            subtitle="The markdown body of SKILL.md — Claude follows this when the skill is active."
            action={
              <span className="font-mono text-[11px] text-bridges-fg3">
                {draft.body.length.toString()} chars · markdown
              </span>
            }
          >
            <textarea
              value={draft.body}
              onChange={e => {
                setDraft(d => (d ? { ...d, body: e.target.value } : d));
              }}
              rows={18}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-bridges-border bg-bridges-surface p-3.5 font-mono text-[12.5px] leading-relaxed text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              style={{ tabSize: 2 }}
            />
          </Section>

          {/* Files */}
          <Section
            icon={<FileCode2 className="h-3.5 w-3.5" />}
            title="Files"
            subtitle="Supporting scripts, references, and assets in this skill directory."
            action={
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1 text-[12px] font-medium text-bridges-fg1 hover:bg-bridges-surface-subtle">
                  <Upload className="h-3 w-3" />
                  Upload
                  <input
                    type="file"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2.5 text-[12px]"
                  onClick={handleNewFile}
                >
                  <Plus className="h-3 w-3" /> New file
                </Button>
              </div>
            }
          >
            <SkillFileTree
              files={detail.files.filter(f => f.path !== 'SKILL.md')}
              selectedPath={fileSheetPath}
              onSelect={p => {
                setFileSheetPath(p);
              }}
              onDelete={p => {
                setConfirmDeleteFile(p);
              }}
            />
            {pendingUploadName && (
              <div className="mt-2 text-[11.5px] text-bridges-fg3">
                Next upload will be saved as{' '}
                <span className="font-mono text-bridges-fg1">{pendingUploadName}</span>.
              </div>
            )}
          </Section>

          {/* Danger zone */}
          <div className="mt-10 rounded-md border border-bridges-border bg-bridges-surface p-4">
            <div className="text-[13px] font-semibold text-bridges-fg1">Danger zone</div>
            <div className="mt-1 text-[12px] text-bridges-fg2">
              Delete this skill directory and all its files. This cannot be undone.
              {detail.isSymlink && (
                <span className="ml-1 text-bridges-tint-warning-fg">
                  Symlinks: only the link is removed, the target stays intact.
                </span>
              )}
            </div>
            <div className="mt-3">
              <Button
                variant="outline"
                className="border-bridges-tint-danger-fg/40 text-bridges-tint-danger-fg hover:bg-bridges-tint-danger-bg"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete skill
              </Button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${detail.name}"?`}
        description={
          detail.isSymlink
            ? 'This removes the symlink in ~/.claude/skills/ but leaves the target directory intact.'
            : 'This permanently removes the skill directory and all of its files.'
        }
        confirmLabel="Delete skill"
        danger
        onConfirm={() => {
          deleteMutation.mutate();
          setConfirmDelete(false);
        }}
      />

      <ConfirmDialog
        open={confirmDeleteFile !== null}
        onOpenChange={open => {
          if (!open) setConfirmDeleteFile(null);
        }}
        title={`Delete ${confirmDeleteFile ?? ''}?`}
        description="This file will be removed from the skill directory. This cannot be undone."
        confirmLabel="Delete file"
        danger
        onConfirm={() => {
          if (confirmDeleteFile) deleteFileMutation.mutate(confirmDeleteFile);
          setConfirmDeleteFile(null);
        }}
      />

      <SkillFileEditor
        open={fileSheetPath !== null}
        onOpenChange={open => {
          if (!open) setFileSheetPath(null);
        }}
        skillName={detail.name}
        source={detail.source}
        cwd={cwd}
        filePath={fileSheetPath}
      />
    </div>
  );
}

// ----- small helpers -----

function Section({
  icon,
  title,
  subtitle,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center gap-3 border-b border-bridges-border-subtle pb-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-bridges-surface-muted text-bridges-fg2">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-tight text-bridges-fg1">{title}</div>
          {subtitle && (
            <div className="mt-0.5 text-[12px] leading-snug text-bridges-fg3">{subtitle}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function MetaField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-bridges-fg3">
        {label}
      </div>
      <div className="min-w-0 text-[13px] text-bridges-fg1">{value}</div>
    </div>
  );
}

function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[11.5px] font-semibold text-bridges-fg2">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-bridges-fg3">{hint}</div>}
    </div>
  );
}

function SourcePill({ source }: { source: SkillSource }): React.ReactElement {
  const isProject = source === 'project';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium',
        'border-bridges-border bg-bridges-surface text-bridges-fg1'
      )}
    >
      <span
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          isProject ? 'bg-bridges-success' : 'bg-bridges-open'
        )}
      />
      {isProject ? 'Project' : 'Global'}
    </span>
  );
}

function SymlinkPill({ realPath }: { realPath: string | null }): React.ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-bridges-tag-violet-fg/30 bg-bridges-tag-violet-bg px-2 py-0.5 text-[11.5px] font-medium text-bridges-tag-violet-fg"
      title={realPath ?? 'symlinked'}
    >
      <Link2 className="h-3 w-3" />
      symlinked
    </span>
  );
}
