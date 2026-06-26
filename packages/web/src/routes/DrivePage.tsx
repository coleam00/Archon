import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Search, ExternalLink, Folder, Eye } from 'lucide-react';
import driveData from '@/lib/drive-index.generated.json';

type Audience = 'all' | 'internal' | 'partner-only' | 'jason-only';

interface DriveFile {
  name: string;
  type: string;
  modified: string;
  size: string;
  link: string;
}

interface DriveFolder {
  id: string;
  slug: string;
  name: string;
  folderId: string;
  parentId: string;
  audience: Audience;
  lastSynced: string;
  fileCount: number;
  vaultPath: string;
  driveUrl: string;
  files: DriveFile[];
}

interface DriveIndexPayload {
  generated_at?: unknown;
  folders?: unknown;
}

function isAudience(value: unknown): value is Audience {
  return (
    value === 'all' || value === 'internal' || value === 'partner-only' || value === 'jason-only'
  );
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeDriveFile(value: unknown): DriveFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as Partial<Record<keyof DriveFile, unknown>>;
  return {
    name: stringField(file.name),
    type: stringField(file.type),
    modified: stringField(file.modified),
    size: stringField(file.size),
    link: stringField(file.link),
  };
}

function normalizeDriveFolder(value: unknown, index: number): DriveFolder | null {
  if (typeof value !== 'object' || value === null) return null;
  const folder = value as Partial<Record<keyof DriveFolder, unknown>>;
  const files = Array.isArray(folder.files)
    ? folder.files.map(normalizeDriveFile).filter((file): file is DriveFile => file !== null)
    : [];
  const slug = stringField(folder.slug) || stringField(folder.id) || `folder-${index + 1}`;
  const fileCount =
    typeof folder.fileCount === 'number' && Number.isFinite(folder.fileCount)
      ? folder.fileCount
      : files.length;
  return {
    id: stringField(folder.id) || slug,
    slug,
    name: stringField(folder.name) || slug,
    folderId: stringField(folder.folderId),
    parentId: stringField(folder.parentId),
    audience: isAudience(folder.audience) ? folder.audience : 'all',
    lastSynced: stringField(folder.lastSynced),
    fileCount,
    vaultPath: stringField(folder.vaultPath),
    driveUrl: stringField(folder.driveUrl),
    files,
  };
}

// Map ?view= query param -> set of audiences a viewer is allowed to see.
// jason-only is internal-superset; partner-only is for sharing scoped folders.
const VIEW_TO_ALLOWED: Record<string, Set<Audience>> = {
  jason: new Set<Audience>(['all', 'internal', 'partner-only', 'jason-only']),
  va: new Set<Audience>(['all', 'internal']),
  partner: new Set<Audience>(['all', 'partner-only']),
};

function visibleForView(view: string, audience: Audience): boolean {
  const allowed = VIEW_TO_ALLOWED[view] ?? VIEW_TO_ALLOWED.jason;
  return allowed.has(audience);
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function typeLabel(t: string): string {
  if (!t) return '';
  if (t.startsWith('g-')) return `Google ${t.slice(2)}`;
  if (t === 'pdf') return 'PDF';
  if (t.startsWith('video/')) return `Video (${t.slice(6)})`;
  if (t.startsWith('audio/')) return `Audio (${t.slice(6)})`;
  return t;
}

export function DrivePage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const view = (searchParams.get('view') ?? 'jason').toLowerCase();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [folderSearch, setFolderSearch] = useState<string>('');
  const [fileSearch, setFileSearch] = useState<string>('');

  const drivePayload = driveData as DriveIndexPayload;
  const allFolders = Array.isArray(drivePayload.folders)
    ? drivePayload.folders
        .map(normalizeDriveFolder)
        .filter((folder): folder is DriveFolder => folder !== null)
    : [];
  // Audience-filter at the folder level
  const visibleFolders = useMemo<DriveFolder[]>(
    () => allFolders.filter(f => visibleForView(view, f.audience)),
    [allFolders, view]
  );

  const folderFiltered = useMemo<DriveFolder[]>(() => {
    const q = folderSearch.trim().toLowerCase();
    if (!q) return visibleFolders;
    return visibleFolders.filter(f => f.name.toLowerCase().includes(q));
  }, [visibleFolders, folderSearch]);

  const selected: DriveFolder | null =
    (selectedSlug && visibleFolders.find(f => f.slug === selectedSlug)) || null;

  const visibleFiles = useMemo<DriveFile[]>(() => {
    if (!selected) return [];
    const q = fileSearch.trim().toLowerCase();
    if (!q) return selected.files;
    return selected.files.filter(
      file => file.name.toLowerCase().includes(q) || file.type.toLowerCase().includes(q)
    );
  }, [selected, fileSearch]);

  return (
    <div className="flex h-full flex-1 flex-col gap-4 p-6">
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Folder rail */}
        <div className="flex w-72 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface-elevated p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
            <input
              type="search"
              value={folderSearch}
              onChange={(e): void => {
                setFolderSearch(e.target.value);
              }}
              placeholder="Filter folders..."
              className="w-full rounded-md border border-border bg-surface-inset py-1.5 pl-7 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            {folderFiltered.length === 0 && (
              <div className="px-2 py-4 text-xs text-text-tertiary">No folders match.</div>
            )}
            {folderFiltered.map(folder => (
              <button
                key={folder.slug}
                type="button"
                onClick={(): void => {
                  setSelectedSlug(folder.slug);
                  setFileSearch('');
                }}
                className={`mb-1 flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                  selected?.slug === folder.slug
                    ? 'bg-surface-inset text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Folder className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                  <span className="truncate">{folder.name}</span>
                </span>
                <span className="shrink-0 rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  {folder.fileCount}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Detail pane */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
              Select a folder to view files.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2 border-b border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-medium text-text-primary">{selected.name}</h2>
                  <div className="flex items-center gap-3 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                        selected.audience === 'all'
                          ? 'border-emerald-700/40 bg-emerald-100 text-emerald-800'
                          : selected.audience === 'internal'
                            ? 'border-amber-700/40 bg-amber-100 text-amber-800'
                            : 'border-rose-700/40 bg-rose-100 text-rose-800'
                      }`}
                    >
                      <Eye className="h-3 w-3" />
                      {selected.audience}
                    </span>
                    {selected.driveUrl && (
                      <a
                        href={selected.driveUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                      >
                        open in Drive <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-text-tertiary">
                  <span>{selected.fileCount} items</span>
                  <span>synced {formatTimestamp(selected.lastSynced)}</span>
                  <span className="font-mono">{selected.vaultPath}</span>
                </div>
                <div className="relative pt-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
                  <input
                    type="search"
                    value={fileSearch}
                    onChange={(e): void => {
                      setFileSearch(e.target.value);
                    }}
                    placeholder="Filter files in this folder..."
                    className="w-full rounded-md border border-border bg-surface-inset py-1.5 pl-7 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {visibleFiles.length === 0 ? (
                  <div className="p-8 text-center text-sm text-text-tertiary">
                    {selected.files.length === 0 ? 'Empty folder.' : 'No files match.'}
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface-elevated/95 text-xs uppercase text-text-tertiary">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">Name</th>
                        <th className="px-4 py-2 text-left font-medium">Type</th>
                        <th className="px-4 py-2 text-left font-medium">Modified</th>
                        <th className="px-4 py-2 text-left font-medium">Size</th>
                        <th className="px-4 py-2 text-right font-medium">Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFiles.map((file, idx) => (
                        <tr
                          key={`${file.name}-${idx}`}
                          className="border-t border-border hover:bg-surface-hover"
                        >
                          <td className="px-4 py-2 text-text-primary">{file.name}</td>
                          <td className="px-4 py-2 text-text-secondary">{typeLabel(file.type)}</td>
                          <td className="px-4 py-2 text-text-secondary">{file.modified}</td>
                          <td className="px-4 py-2 text-text-secondary">{file.size}</td>
                          <td className="px-4 py-2 text-right">
                            {file.link ? (
                              <a
                                href={file.link}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                              >
                                open <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="text-text-tertiary">--</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
