import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useProject } from '@/contexts/ProjectContext';
import { SkillList } from '@/components/skills/SkillList';
import { SkillEditor } from '@/components/skills/SkillEditor';
import { CreateSkillDialog } from '@/components/skills/CreateSkillDialog';
import type { SkillSource } from '@/lib/api';

export function SkillsPage(): React.ReactElement {
  const navigate = useNavigate();
  const params = useParams<{ name?: string }>();
  const [searchParams] = useSearchParams();
  const { selectedProjectId, codebases } = useProject();
  const [createOpen, setCreateOpen] = useState(false);

  const cwd = codebases?.find(c => c.id === selectedProjectId)?.default_cwd;
  const selectedName = params.name ?? null;
  const sourceParam = searchParams.get('source');
  const selectedSource: SkillSource | null =
    sourceParam === 'global' || sourceParam === 'project' ? sourceParam : null;

  return (
    <div className="flex flex-1 overflow-hidden bg-bridges-bg">
      <SkillList
        cwd={cwd}
        selectedName={selectedName}
        selectedSource={selectedSource}
        onSelect={skill => {
          navigate(`/skills/${encodeURIComponent(skill.name)}?source=${skill.source}`);
        }}
        onCreate={() => {
          setCreateOpen(true);
        }}
      />
      <SkillEditor
        cwd={cwd}
        name={selectedName}
        source={selectedSource}
        onDeleted={() => {
          navigate('/skills');
        }}
      />
      <CreateSkillDialog
        open={createOpen}
        cwd={cwd}
        onOpenChange={setCreateOpen}
        onCreated={skill => {
          setCreateOpen(false);
          navigate(`/skills/${encodeURIComponent(skill.name)}?source=${skill.source}`);
        }}
      />
    </div>
  );
}
