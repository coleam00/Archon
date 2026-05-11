import { useQuery } from '@tanstack/react-query';
import { listCommands, type CommandEntry } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';

export function NodePalette(): React.ReactElement {
  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  const {
    data: commands,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => listCommands(cwd),
  });

  const onDragStart = (
    e: React.DragEvent,
    type: 'command' | 'prompt' | 'bash',
    name: string
  ): void => {
    e.dataTransfer.setData('application/reactflow-type', type);
    e.dataTransfer.setData('application/reactflow-command', name);
    e.dataTransfer.effectAllowed = 'move';
  };

  const bundled = commands?.filter((c: CommandEntry) => c.source === 'bundled') ?? [];
  const global = commands?.filter((c: CommandEntry) => c.source === 'global') ?? [];
  const project = commands?.filter((c: CommandEntry) => c.source === 'project') ?? [];

  return (
    <div className="flex flex-col h-full overflow-auto p-2">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
        Nodes
      </h3>

      {/* Prompt node */}
      <div
        draggable
        onDragStart={(e): void => {
          onDragStart(e, 'prompt', 'Prompt');
        }}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary mb-1"
      >
        <span className="text-[10px] text-accent font-medium">PROMPT</span>
        <span>Inline prompt</span>
      </div>

      {/* Bash node */}
      <div
        draggable
        onDragStart={(e): void => {
          onDragStart(e, 'bash', 'Shell');
        }}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary mb-2"
      >
        <span className="text-[10px] text-accent font-medium">BASH</span>
        <span>Shell script</span>
      </div>

      {isLoading && <p className="text-xs text-text-tertiary">Loading commands...</p>}
      {isError && (
        <p className="text-xs text-error">
          Failed to load commands: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      )}

      {project.length > 0 && (
        <>
          <h4 className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mt-2 mb-1">
            Project
          </h4>
          {project.map((cmd: CommandEntry) => (
            <div
              key={cmd.name}
              draggable
              onDragStart={(e): void => {
                onDragStart(e, 'command', cmd.name);
              }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary mb-1"
            >
              <span className="text-[10px] text-text-tertiary font-medium">CMD</span>
              <span className="truncate">{cmd.name}</span>
            </div>
          ))}
        </>
      )}

      {global.length > 0 && (
        <>
          <h4 className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mt-2 mb-1">
            Global (~/.archon/commands/)
          </h4>
          {global.map((cmd: CommandEntry) => (
            <div
              key={cmd.name}
              draggable
              onDragStart={(e): void => {
                onDragStart(e, 'command', cmd.name);
              }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary mb-1"
            >
              <span className="text-[10px] text-text-tertiary font-medium">CMD</span>
              <span className="truncate">{cmd.name}</span>
            </div>
          ))}
        </>
      )}

      {bundled.length > 0 && (
        <>
          <h4 className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mt-2 mb-1">
            Bundled
          </h4>
          {bundled.map((cmd: CommandEntry) => (
            <div
              key={cmd.name}
              draggable
              onDragStart={(e): void => {
                onDragStart(e, 'command', cmd.name);
              }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary mb-1"
            >
              <span className="text-[10px] text-text-tertiary font-medium">CMD</span>
              <span className="truncate">{cmd.name}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
