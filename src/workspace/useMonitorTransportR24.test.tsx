// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from './testApiMock';
vi.mock('../api', async () => createTestApiMock());
import type { ClipListItem, PlayerCommand, PlayerStatus } from '../api';
import { useMonitorTransport } from './useMonitorTransport';

afterEach(cleanup);
it.each(['play', 'button', 'shuttle', 'rate', 'loop', 'clip'] as const)(
  'P-1 %s clears the seek hold for future gesture resumes', async method => {
    const send = vi.fn(async (_commands: PlayerCommand[]) => {});
    const deps = { clip: { id: 7, fps_num: 25, fps_den: 1 } as ClipListItem,
      status: { phase: 'ready', clip_id: 7, pos: 8, duration: 60, paused: true } as PlayerStatus,
      send, inPoint: 3, outPoint: 10, bestStart: null, momentsLoaded: true };
    const h = renderHook(p => useMonitorTransport(p), { initialProps: deps });
    await act(async () => { await h.result.current.setEnd(10); await h.result.current.seekTo(8); });
    send.mockClear();
    await act(async () => { await h.result.current.gestureResume(); });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      if (method === 'play') await h.result.current.play();
      if (method === 'button') await send([...h.result.current.userPlayCommands(), { type: 'play' }]);
      if (method === 'shuttle') h.result.current.shuttle('l');
      if (method === 'rate') h.result.current.setRate(2);
      if (method === 'loop') h.result.current.toggleLoop();
      if (method === 'clip') h.rerender({ ...deps, clip: { ...deps.clip, id: 9 }, status: { ...deps.status, clip_id: 9 } });
    });
    send.mockClear();
    await act(async () => { await h.result.current.gestureResume(); });
    expect(send).toHaveBeenCalledWith([{ type: 'play' }]);
  },
);
