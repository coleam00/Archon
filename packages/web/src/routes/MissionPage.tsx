import { useSearchParams } from 'react-router';
import { useMissionSSE } from '@/hooks/useMissionSSE';
import { useDrawerHash } from '@/hooks/useDrawerHash';
import { HistoryView } from '@/components/mission/HistoryView';
import { ApprovalsTab } from '@/components/mission/ApprovalsTab';
import { MissionStatusBar } from '@/components/mission/MissionStatusBar';
import { MissionDetailDrawer } from '@/components/mission/MissionDetailDrawer';
import { BoardTab } from '@/components/mission/BoardTab';
import { FeedTab } from '@/components/mission/FeedTab';
import { SymphonyTab } from '@/components/mission/SymphonyTab';
import { ArtifactsTab } from '@/components/mission/ArtifactsTab';
import { WorktreesTab } from '@/components/mission/WorktreesTab';

type MissionTab =
  | 'board'
  | 'approvals'
  | 'history'
  | 'symphony'
  | 'feed'
  | 'artifacts'
  | 'worktrees';

const VALID_TABS = new Set<MissionTab>([
  'board',
  'approvals',
  'history',
  'symphony',
  'feed',
  'artifacts',
  'worktrees',
]);

export function MissionPage(): React.ReactElement {
  // Single SSE connection scoped to the mission view; tabs share live state.
  useMissionSSE();

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as MissionTab | null;
  const tab: MissionTab = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'board';

  // Single drawer for the entire page; URL-synced via ?run=<id>.
  const { openRunId, openRun, closeRun } = useDrawerHash();

  function setTab(next: MissionTab): void {
    setSearchParams(
      prev => {
        const out = new URLSearchParams(prev);
        if (next === 'board') {
          out.delete('tab');
        } else {
          out.set('tab', next);
        }
        return out;
      },
      { replace: true }
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bridges-bg">
      <MissionStatusBar
        onJumpToApprovals={() => {
          setTab('approvals');
        }}
      />

      <div className="flex-1 overflow-y-auto">
        <TabContent tab={tab} onOpenRun={openRun} />
      </div>

      <MissionDetailDrawer runId={openRunId} onClose={closeRun} />
    </div>
  );
}

function TabContent({
  tab,
  onOpenRun,
}: {
  tab: MissionTab;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  switch (tab) {
    case 'board':
      return <BoardTab onOpenRun={onOpenRun} />;
    case 'approvals':
      return <ApprovalsTab />;
    case 'history':
      return <HistoryView onOpenRun={onOpenRun} />;
    case 'symphony':
      return <SymphonyTab />;
    case 'feed':
      return <FeedTab onOpenRun={onOpenRun} />;
    case 'artifacts':
      return <ArtifactsTab />;
    case 'worktrees':
      return <WorktreesTab />;
  }
}
