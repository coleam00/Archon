import { useState } from 'react';
import type { WorkflowArtifact } from '@/lib/types';
import { ArtifactViewerModal } from './ArtifactViewerModal';

interface ArtifactSummaryProps {
  artifacts: WorkflowArtifact[];
  runId: string;
}

const FILE_ARTIFACT_TYPES = new Set(['file', 'file_created', 'file_modified']);

function ArtifactLabel({
  artifact,
  onFileClick,
}: {
  artifact: WorkflowArtifact;
  onFileClick: (path: string) => void;
}): React.ReactElement {
  if (artifact.url) {
    return (
      <a
        href={artifact.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:text-accent-bright transition-colors truncate"
      >
        {artifact.label}
      </a>
    );
  }
  const filePath = artifact.path;
  if (FILE_ARTIFACT_TYPES.has(artifact.type) && filePath) {
    return (
      <button
        type="button"
        className="text-accent hover:text-accent-bright transition-colors truncate text-left"
        onClick={() => {
          onFileClick(filePath);
        }}
      >
        {artifact.label}
      </button>
    );
  }
  return <span className="text-text-primary truncate">{artifact.label}</span>;
}

function ArtifactIcon({ type }: { type: string }): React.ReactElement {
  switch (type) {
    case 'pr':
      return <span className="text-accent">PR</span>;
    case 'commit':
      return <span className="text-success">C</span>;
    case 'branch':
      return <span className="text-text-secondary">B</span>;
    case 'file':
    case 'file_created':
    case 'file_modified':
      return <span className="text-text-secondary">F</span>;
    default:
      return <span className="text-text-secondary">*</span>;
  }
}

export function ArtifactSummary({ artifacts, runId }: ArtifactSummaryProps): React.ReactElement {
  const [viewerFilename, setViewerFilename] = useState<string | null>(null);

  if (artifacts.length === 0) {
    return <></>;
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-surface p-3">
        <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
          Artifacts
        </h4>
        <div className="space-y-1.5">
          {artifacts.map((artifact, idx) => (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <ArtifactIcon type={artifact.type} />
              <ArtifactLabel artifact={artifact} onFileClick={setViewerFilename} />
              {artifact.path && (
                <span
                  className="text-xs text-text-secondary ml-auto shrink-0 truncate max-w-[200px]"
                  title={artifact.path}
                >
                  {artifact.path}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      {viewerFilename && (
        <ArtifactViewerModal
          open={true}
          onOpenChange={() => {
            setViewerFilename(null);
          }}
          runId={runId}
          filename={viewerFilename}
        />
      )}
    </>
  );
}
