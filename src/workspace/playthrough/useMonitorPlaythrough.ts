import { useEffect } from 'react';
import type { PlayerStatus } from '../../api';
import { dispatchWorkspace, getWorkspaceSnapshot, isInspectorOpen, useWorkspace } from '../WorkspaceStore';
import { useHomeOpen } from '../homeStore';
import type { MonitorTransport } from '../useMonitorTransport';
import { showToast } from '../ui';
import { publishPlaythrough, usePlaythroughCommands, usePlaythroughSegments } from './store';
import { usePlaythrough } from './usePlaythrough';

const selectClip = (clipId: number) => {
  dispatchWorkspace({ type: 'select-clip', clipId, source: 'segment' });
  const state = getWorkspaceSnapshot();
  // 自动接段不要每次弹出滑动检查器盖住连播按钮;钉住的检查器照旧。
  if (!state.inspectorPinned && isInspectorOpen(state)) dispatchWorkspace({ type: 'toggle-pane', pane: 'inspector' });
};
export function useMonitorPlaythrough(transport: MonitorTransport, status: PlayerStatus | null, selectedClipId: number | null, enabled: boolean) {
  const segments = usePlaythroughSegments();
  const home = useHomeOpen();
  const episode = useWorkspace(s => s.viewingEpisode);
  const c = usePlaythrough({ segments, selectedClipId, status, autoAdvance: transport.autoAdvance, enabled: enabled && !home, transport, selectClip });
  usePlaythroughCommands(c, enabled && !home);
  useEffect(() => publishPlaythrough(c), [c]);
  useEffect(() => () => publishPlaythrough(null), []);
  useEffect(() => { c.stop(); }, [episode, c.stop]);
  useEffect(() => { if (c.error) showToast(c.error, { tone: 'danger' }); }, [c.error]);
  return c;
}
