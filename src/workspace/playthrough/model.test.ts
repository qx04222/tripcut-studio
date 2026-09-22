import { expect, it } from 'vitest';
import type { ClipListItem, Storyboard } from '../../api';
import { buildBandChapters } from '../shotBandModel';
import { playthroughSegments, playthroughProgress, playthroughReadout } from './model';
it('复用章顺序和 story_order(position),各素材独立时基,跳过空槽/照片/零时长', () => {
  const clips = new Map([1, 2, 3].map(id => [id, { id, kind: 'video', fps_num: 25, fps_den: 1 } as ClipListItem]));
  const item = (key: string, chapter_id: number, position: number, clip_id = 1) => ({
    key, chapter_id, position, clip_id, segment_id: position, in_ticks: 50, out_ticks: 100, tb_num: 1, tb_den: 25,
  });
  const board = { chapters: [{ id: 8, title: 'A' }, { id: 2, title: 'B' }], items: [
    item('third', 2, 0, 2), item('second', 8, 4), item('first', 8, 2),
    { ...item('invalid', 2, 5, 3), out_ticks: 50 },
  ] } as unknown as Storyboard;
  const sequence = playthroughSegments(buildBandChapters(board, [], [], clips), clips);
  expect(sequence.map(s => s.key)).toEqual(['first', 'second', 'third']);
  expect(sequence.map(s => s.chapter)).toEqual(['1', '1', '2']);
  expect(sequence[0]).toMatchObject({ inPoint: 2, outPoint: 4, fps: 25 });
  expect(playthroughProgress(sequence, 2, 3)).toEqual({ elapsed: 5, duration: 6 });
});

it.each([
  ['stopping', 33.9], ['loading', 39.4], ['frame', 39.4], ['running', 40.2],
] as const)('P-2 %s uses position from the committed segment', (stage, expected) => {
  const position = stage === 'running' ? 40.2 : 33.9;
  const range = { index: stage === 'stopping' ? 0 : 1, total: 2,
    inPoint: stage === 'stopping' ? 26.4 : 39.4, outPoint: 45.6, stage };
  expect(playthroughReadout(range, position)).toEqual({ index: range.index, total: 2,
    position: expected, switching: stage !== 'running' });
});
