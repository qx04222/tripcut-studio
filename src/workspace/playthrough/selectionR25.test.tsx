// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import type { ClipListItem } from '../../api';
import { useMonitorTransport } from '../useMonitorTransport';
import { __resetPlayerPrefsForTests } from '../playerPrefs';
import { dispatchWorkspace } from '../WorkspaceStore';
import { FakePlayer } from './fakePlayer';
import { usePlaythrough } from './usePlaythrough';
import { usePlaythroughCommands, takeOpenAt } from './store';
import { getActiveSelection, requestSegmentSelection, setActiveSelection } from './selection';
import type { PlaythroughSegment } from './model';
const segment = (key: string, clipId: number, start: number, chapter = '1', fps = 50): PlaythroughSegment =>
  ({ key, clipId, inPoint: start, outPoint: start + 8, chapter, fps });
beforeEach(() => { __resetPlayerPrefsForTests(); setActiveSelection(null); });
afterEach(cleanup);
function mount(list: PlaythroughSegment[], autoAdvance = false) {
  const player = new FakePlayer({ clips: new Map([[1, 200], [2, 200]]), clipId: 1, fps: list[0]!.fps });
  const open = vi.fn((id: number) => { const at = takeOpenAt(id); player.open(id, true, at?.seconds); });
  const h = renderHook(() => {
    const [status, setStatus] = useState(player.status());
    const [id, setId] = useState(1);
    const send = async (commands: Parameters<typeof player.send>[0]) => { await player.send(commands); setStatus(player.status()); };
    const transport = useMonitorTransport({ clip: { id, fps_num: list[0]!.fps, fps_den: 1 } as ClipListItem, status, send, inPoint: 5, outPoint: 13 });
    const c = usePlaythrough({ segments: list, selectedClipId: id, status, transport, autoAdvance, enabled: true,
      selectClip: next => { if (next !== id) open(next); setId(next); setStatus(player.status()); } });
    usePlaythroughCommands(c, true);
    return { c, transport, pump: () => { player.tick(); setStatus(player.status()); } };
  });
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) await act(async () => h.result.current.pump()); };
  return { ...h, player, open, tick };
}
it.each([30, 50, 60])('001: %i fps six shots across three chapters stop within 0.10s with no unselected samples or next open', async fps => {
  const list = Array.from({ length: 6 }, (_, i) => segment(`s${i}`, 1, 10 + 20*i, String(1 + Math.floor(i/2)), fps));
  const h = mount(list);
  for (const s of list) {
    await act(async () => requestSegmentSelection(s, s.inPoint, true));
    h.player.samples.length = 0;
    await h.tick(110);
    expect(h.player.paused).toBe(true);
    expect(Math.abs(h.player.pos - s.outPoint)).toBeLessThanOrEqual(.1);
    expect(h.result.current.c.segment?.key).toBe(s.key);
    expect(h.player.samples.filter(p => !p.paused && (p.pos < s.inPoint || p.pos >= s.outPoint))).toEqual([]);
  }
  expect(h.open).not.toHaveBeenCalled();
});
it('001: band click lands inside segment paused; Play starts there; end Play replays in-point', async () => {
  const s = segment('s', 1, 138.5);
  const h = mount([s]);
  await act(async () => requestSegmentSelection(s, 140));
  expect(h.player.pos).toBe(140);
  expect(h.player.paused).toBe(true);
  expect(h.player.endFence).toBe(146.5);
  await act(async () => h.result.current.c.resume());
  expect(h.player.pos).toBe(140);
  await h.tick(100);
  expect(h.result.current.c.phase).toBe('done');
  await act(async () => h.result.current.c.resume());
  expect(h.player.pos).toBe(138.5);
  expect(h.player.paused).toBe(false);
  expect(h.player.endFence).toBe(146.5);
});
it('001: inside seek retains selection/fence; outside seek exits and gesture resume cannot auto-play', async () => {
  const s = segment('s', 1, 20);
  const h = mount([s]);
  await act(async () => requestSegmentSelection(s, 20, true));
  await act(async () => h.result.current.transport.seekTo(24));
  expect(getActiveSelection()?.key).toBe('s');
  expect(h.player.endFence).toBe(28);
  expect(h.player.paused).toBe(true);
  await act(async () => h.result.current.c.resume());
  expect(h.player.paused).toBe(false);
  await act(async () => h.result.current.transport.seekTo(40));
  await act(async () => h.result.current.transport.gestureResume());
  expect(getActiveSelection()).toBeNull();
  expect(h.player.endFence).toBeNull();
  expect(h.player.pos).toBe(40);
  expect(h.player.paused).toBe(true);
});
it('001: autoAdvance on skips same-source gaps and opens next source at its in-point', async () => {
  const list = [segment('a', 1, 20), segment('b', 1, 40), segment('c', 2, 5)];
  const h = mount(list, true);
  await act(async () => requestSegmentSelection(list[0]!, 20, true));
  await h.tick(330);
  expect(h.result.current.c.phase).toBe('done');
  expect(h.open).toHaveBeenCalledExactlyOnceWith(2);
  expect(h.player.samples.filter(p => !p.paused && p.clipId === 1 && p.pos > 28 && p.pos < 40)).toEqual([]);
  expect(h.player.samples.filter(p => !p.paused && p.clipId === 2 && p.pos < 5)).toEqual([]);
});
it('001/002: pool selection including same clip exits selection and removes fence', async () => {
  const s = segment('s', 1, 20), h = mount([s]);
  await act(async () => requestSegmentSelection(s, 20, true));
  await act(async () => dispatchWorkspace({ type: 'select-clip', clipId: 1 }));
  expect(getActiveSelection()).toBeNull();
  expect(h.result.current.c.phase).toBe('idle');
  expect(h.player.endFence).toBeNull();
});
it('001: deferred old pause cannot select/seek/play after replacement segment request', async () => {
  const list = [segment('a', 1, 20), segment('b', 2, 40)];
  const h = mount(list);
  const original = h.result.current.transport.pause;
  let finish!: () => void;
  h.result.current.transport.pause = () => new Promise<void>(r => { finish = r; });
  // Controller retains its transport object for this turn.
  act(() => requestSegmentSelection(list[0]!, 20, true));
  await act(async () => h.result.current.c.stop());
  h.result.current.transport.pause = original;
  await act(async () => finish());
  expect(h.open).not.toHaveBeenCalled();
  expect(h.player.commands.filter(c => c.cmd.type === 'play' || c.cmd.type === 'seek_abs')).toEqual([]);
});
