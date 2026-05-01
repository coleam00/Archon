import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useProject } from '@/contexts/ProjectContext';
import { AgentList } from '@/components/agents/AgentList';
import { AgentEditor } from '@/components/agents/AgentEditor';
import { CreateAgentDialog } from '@/components/agents/CreateAgentDialog';
import type { AgentSource } from '@/lib/api';

export function AgentsPage(): React.ReactElement {
  const navigate = useNavigate();
  const params = useParams<{ name?: string }>();
  const [searchParams] = useSearchParams();
  const { selectedProjectId, codebases } = useProject();
  const [createOpen, setCreateOpen] = useState(false);

  const cwd = codebases?.find(c => c.id === selectedProjectId)?.default_cwd;
  const selectedName = params.name ?? null;
  const sourceParam = searchParams.get('source');
  const selectedSource: AgentSource | null =
    sourceParam === 'global' || sourceParam === 'project' ? sourceParam : null;

  return (
    <div className="flex flex-1 overflow-hidden bg-bridges-bg">
      <AgentList
        cwd={cwd}
        selectedName={selectedName}
        selectedSource={selectedSource}
        onSelect={agent => {
          navigate(`/agents/${encodeURIComponent(agent.name)}?source=${agent.source}`);
        }}
        onCreate={() => {
          setCreateOpen(true);
        }}
      />
      <AgentEditor
        cwd={cwd}
        name={selectedName}
        source={selectedSource}
        onDeleted={() => {
          navigate('/agents');
        }}
      />
      <CreateAgentDialog
        open={createOpen}
        cwd={cwd}
        onOpenChange={setCreateOpen}
        onCreated={agent => {
          setCreateOpen(false);
          navigate(`/agents/${encodeURIComponent(agent.name)}?source=${agent.source}`);
        }}
      />
    </div>
  );
}
