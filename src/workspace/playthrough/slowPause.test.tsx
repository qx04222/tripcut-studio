// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import type { ClipListItem } from '../../api';
import { useMonitorTransport } from '../useMonitorTransport';
import { FakePlayer } from './fakePlayer';
import { usePlaythrough, type PlaythroughController } from './usePlaythrough';
import { isPlaythroughActive, publishPlaythrough, takeOpenAt } from './store';

const segments = [
  { key: 'a', clipId: 7, inPoint: 10, outPoint: 20, fps: 25, chapter: '1' },
  { key: 'b', clipId: 7, inPoint: 30, outPoint: 40, fps: 25, chapter: '1' },
  { key: 'c', clipId: 9, inPoint: 3, outPoint: 13, fps: 25, chapter: '2' },
];
afterEach(() => { cleanup(); publishPlaythrough(null); });

it('25 tick 慢 Pause:同素材再跨素材 next,停旧段期间不提前提交新段', async () => {
  const player = new FakePlayer({ clips: new Map([[7, 90], [9, 60]]), clipId: 7, pauseTicks: 25 });
  let controller!: PlaythroughController;
  let pump!: () => void;
  const indices: number[] = [];
  function Host() {
    const [status, setStatus] = useState(player.status());
    const [clipId, setClipId] = useState(7);
    pump = () => setStatus(player.status());
    const transport = useMonitorTransport({
      clip: { id: clipId, fps_num: 25, fps_den: 1 } as ClipListItem,
      status, send: player.send, inPoint: null, outPoint: null, playthroughActive: isPlaythroughActive(),
    });
    controller = usePlaythrough({ segments, selectedClipId: clipId, status, enabled: true, transport,
      selectClip: id => {
        if (id !== player.clipId) player.open(id, isPlaythroughActive(), takeOpenAt(id)?.seconds);
        setClipId(id);
      },
    });
    publishPlaythrough(controller);
    return null;
  }
  render(<Host />);
  const run = async (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        player.tick(); pump();
        for (let k = 0; k < 8; k++) await Promise.resolve();
      });
      expect(controller.error).toBeNull();
      indices.push(controller.index);
    }
  };
  await act(async () => controller.start());
  await run(35);
  expect(controller.stage).toBe('running');
  for (let index = 0; index < 3; index++) {
    const segment = segments[index]!;
    expect(controller.index).toBe(index);
    expect(player.clipId).toBe(segment.clipId);
    expect(player.pos).toBeGreaterThan(segment.inPoint);
    expect(player.pos).toBeLessThan(segment.outPoint);
    if (index === 2) break;
    const at = player.elapsed;
    const pauseCount = player.commands.filter(c => c.cmd.type === 'pause').length;
    await act(async () => controller.next());
    expect(controller.error).toBeNull();
    expect(controller.stage).toBe('stopping');
    await run(24);
    expect(controller.index).toBe(index);
    expect(controller.stage).toBe('stopping');
    expect(player.commands.filter(c => c.cmd.type === 'pause')).toHaveLength(pauseCount);
    await run(1);
    expect(player.commands.filter(c => c.cmd.type === 'pause').at(-1)?.t).toBe(at + 25 * 80);
    await run(10);
    expect(controller.stage).toBe('running');
  }
  expect(indices.filter((v, i) => i === 0 || v !== indices[i - 1])).toEqual([0, 1, 2]);
});

it('慢 Pause 挂起同一批后续命令,到期才记录落地时间', async () => {
  const player = new FakePlayer({ clips: new Map([[7, 90]]), clipId: 7, pauseTicks: 2 });
  await player.send([{ type: 'play' }]);
  let settled = false;
  const batch = player.send([{ type: 'pause' }, { type: 'seek_abs', seconds: 30 }]).then(() => { settled = true; });
  player.tick(); await Promise.resolve();
  expect(settled).toBe(false);
  expect(player.pos).toBeCloseTo(0.08);
  expect(player.commands.map(c => c.cmd.type)).toEqual(['play']);
  player.tick();
  expect(player.commands.at(-1)).toEqual({ t: 160, cmd: { type: 'pause' } });
  await batch;
  expect(player.paused).toBe(true);
  expect(player.pos).toBe(30);
  expect(player.commands.slice(1).map(c => c.t)).toEqual([160, 160]);
});
