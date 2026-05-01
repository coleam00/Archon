import { useSearchParams } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

const TABS: { value: MissionTab; label: string }[] = [
  { value: 'board', label: 'Board' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'history', label: 'History' },
  { value: 'symphony', label: 'Symphony' },
  { value: 'feed', label: 'Feed' },
  { value: 'artifacts', label: 'Artifacts' },
  { value: 'worktrees', label: 'Worktrees' },
];

const VALID_TABS = new Set<MissionTab>(TABS.map(t => t.value));

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
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold text-text-primary">Mission Control</h1>
        <p className="text-xs text-muted-foreground">
          Observe and control every workflow run, dispatch, and artifact in one place.
        </p>
      </div>

      <MissionStatusBar
        onJumpToApprovals={() => {
          setTab('approvals');
        }}
      />

      <Tabs
        value={tab}
        onValueChange={value => {
          setTab(value as MissionTab);
        }}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <TabsList className="mx-4 mt-3 flex flex-wrap self-start">
          {TABS.map(t => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="board" className="flex-1 overflow-y-auto px-4 py-4">
          <BoardTab onOpenRun={openRun} />
        </TabsContent>

        <TabsContent value="approvals" className="flex-1 overflow-y-auto px-4 py-4">
          <ApprovalsTab />
        </TabsContent>

        <TabsContent value="history" className="flex-1 overflow-y-auto px-4 py-4">
          <HistoryView onOpenRun={openRun} />
        </TabsContent>

        <TabsContent value="symphony" className="flex-1 overflow-y-auto px-4 py-4">
          <SymphonyTab />
        </TabsContent>

        <TabsContent value="feed" className="flex-1 overflow-hidden px-4 py-4">
          <FeedTab onOpenRun={openRun} />
        </TabsContent>

        <TabsContent value="artifacts" className="flex-1 overflow-y-auto px-4 py-4">
          <ArtifactsTab />
        </TabsContent>

        <TabsContent value="worktrees" className="flex-1 overflow-y-auto px-4 py-4">
          <WorktreesTab />
        </TabsContent>
      </Tabs>

      <MissionDetailDrawer runId={openRunId} onClose={closeRun} />
    </div>
  );
}
