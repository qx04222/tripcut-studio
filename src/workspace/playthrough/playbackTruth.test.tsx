// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import type { ClipListItem, PlayerStatus } from '../../api';
import { useMonitorTransport } from '../useMonitorTransport';
import { Scrubber } from '../scrubber/Scrubber';
import { FakePlayer } from './fakePlayer';
import { usePlaythrough } from './usePlaythrough';
import { isPlaythroughActive, publishPlaythrough, takeOpenAt, releasePlaythrough } from './store';
import type { PlaythroughSegment } from './model';

/**
 * R23「播放真值」车道的复现 + 验收装置(交接报告 §3 / §4 / §8)。
 *
 * 不手喂状态:自走播放器 + 真 useMonitorTransport + 真 usePlaythrough + 真 Scrubber,
 * 按 80 ms(= PlayerOverlay 的 STATUS_INTERVAL_MS)轮询采样。判据全落在采样上;
 * 「指针 clamp 到边缘」不算通过 —— 越界时 Scrubber 挂 data-out-of-range,测试盯它。
 */

afterEach(() => { cleanup(); publishPlaythrough(null); });

const TOL = 0.1; // §8A 允许的边界误差
const clip = (id: number): ClipListItem => ({ id, fps_num: 25, fps_den: 1, tb_num: 1, tb_den: 1000, kind: 'video' } as ClipListItem);
const seg = (key: string, clipId: number, inPoint: number, outPoint: number): PlaythroughSegment =>
  ({ key, clipId, inPoint, outPoint, fps: 25, chapter: '2' });

interface Sample {
  t: number; clipId: number; axValue: number; axText: string | null;
  /** 界面看到的(80 ms 轮询回来的状态)。 */
  pos: number; paused: boolean;
  /** 播放器此刻的真身 —— 「放没放用户没选的画面」只能按它判,轮询读数会滞后一拍。 */
  truePos: number; truePaused: boolean;
  index: number; segIn: number; segOut: number; outOfRange: boolean; headPct: number | null; bandLeft: string | null;
}

function harness(segments: readonly PlaythroughSegment[], options: {
  durations: ReadonlyMap<number, number>;
  /** 监视器 I/O 栏此刻填的值 = AI 建议(报告 §4.2 四行错误刻度都正好 8 s 宽)。 */
  suggestion?: readonly [number, number] | null;
  seekLandTicks?: number;
  openTicks?: number;
}) {
  const player = new FakePlayer({
    clips: options.durations, clipId: segments[0]!.clipId,
    seekLandTicks: options.seekLandTicks, openTicks: options.openTicks,
  });
  const samples: Sample[] = [];
  let pump: (() => void) | null = null;
  let controller: ReturnType<typeof usePlaythrough> | null = null;
  let transportRef: ReturnType<typeof useMonitorTransport> | null = null;

  function Host() {
    const [status, setStatus] = useState<PlayerStatus | null>(() => player.status());
    const [selectedClipId, setSelectedClipId] = useState(segments[0]!.clipId);
    const [, force] = useState(0);
    pump = () => { setStatus(player.status()); force(n => n + 1); };
    const [inPoint, outPoint] = options.suggestion ?? [null, null];
    const transport = useMonitorTransport({
      clip: clip(selectedClipId), status, send: player.send,
      inPoint, outPoint, bestStart: null, momentsLoaded: true,
      playthroughActive: isPlaythroughActive(),
    });
    transportRef = transport;
    const c = usePlaythrough({
      segments, selectedClipId, status, enabled: true, transport,
      // PlayerOverlay 的真实接线:换素材时按连播在不在跑决定开原片停不停在首帧。
      selectClip: (id: number) => { if (id !== player.clipId) player.open(id, isPlaythroughActive(), takeOpenAt(id)?.seconds); setSelectedClipId(id); },
    });
    controller = c;
    publishPlaythrough(c);
    const range = c.active && c.segment
      ? { inPoint: c.segment.inPoint, outPoint: c.segment.outPoint, index: c.index, total: c.total, switching: c.switching, stage: c.stage }
      : undefined;
    useEffect(() => {
      if (!status || status.phase !== 'ready') return;
      const track = document.querySelector<HTMLElement>('.scrubber-r22-track');
      const head = document.querySelector<HTMLElement>('.scrubber-r22-head');
      const band = document.querySelector<HTMLElement>('.scrubber-r22-playthrough');
      samples.push({
        axValue: Number(track?.getAttribute("aria-valuenow")), axText: track?.getAttribute("aria-valuetext") ?? null,
        t: player.elapsed, clipId: status.clip_id ?? -1, pos: status.pos, paused: status.paused,
        truePos: player.pos, truePaused: player.paused,
        index: c.index, segIn: c.segment?.inPoint ?? -1, segOut: c.segment?.outPoint ?? -1,
        outOfRange: track?.hasAttribute('data-out-of-range') ?? false,
        headPct: head ? Number.parseFloat(head.style.left) : null,
        bandLeft: band ? band.style.left : null,
      });
    });
    return <Scrubber status={status} inPoint={inPoint} outPoint={outPoint} fps={25} onSeek={transport.seekTo}
      onPause={transport.gesturePause} onResume={transport.gestureResume} playthrough={range} />;
  }
  render(<Host />);
  const run = async (ticks: number) => {
    for (let i = 0; i < ticks; i += 1) {
      await act(async () => {
        player.tick();
        pump?.();
        for (let k = 0; k < 8; k += 1) await Promise.resolve();
      });
    }
  };
  const call = async (fn: () => void) => { await act(async () => { fn(); }); await run(3); };
  const seeks = () => player.commands.filter(c => c.cmd.type === 'seek_abs').map(c => (c.cmd as { seconds: number }).seconds);
  return {
    player, samples, run, call, seeks,
    start: (index = 0) => call(() => controller!.start(index)),
    get controller() { return controller!; },
    get transport() { return transportRef!; },
    /** 播放中(没暂停)落在活动选段之外的采样 —— 这就是「播了未选原片」的证据。 */
    outside: () => samples.filter(s => !s.truePaused && s.segIn >= 0 &&
      (s.truePos > s.segOut + TOL || s.truePos < s.segIn - TOL)),
  };
}

const A_SEGMENTS = [seg('s1', 7, 26.4, 34.2), seg('s2', 7, 39.4, 45.6)];
const A_OPTIONS = { durations: new Map([[7, 121]]), suggestion: [5, 13] as const };

it('§8A 单素材两个不连续选段:不进 (34.2, 39.4),两段各自从真实入点起、真实出点止', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(300);
  const gap = h.samples.filter(s => !s.truePaused && s.truePos > 34.2 + TOL && s.truePos < 39.4 - TOL);
  expect({ gap: gap.map(s => s.truePos), outside: h.outside().map(s => [s.index, s.truePos]) })
    .toEqual({ gap: [], outside: [] });
  // 两段都播过,且第二段真的 seek 过去了(不是顺着原片放过间隔)。
  expect(new Set(h.samples.filter(s => !s.truePaused).map(s => s.index))).toEqual(new Set([0, 1]));
  expect(h.seeks()).toContain(39.4);
  expect(h.controller.phase).toBe('done');
});

it('§8A 出点围栏由播放器自己守:每段开播前设 end,播完保留选段围栏', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(300);
  const fences = h.player.commands.filter(c => c.cmd.type === 'set_end')
    .map(c => (c.cmd as { seconds: number | null }).seconds);
  expect(fences.filter(v => v !== null)).toEqual([34.2, 45.6]);
  expect(fences.at(-1)).toBe(45.6);
});

it('§8B 跨素材:新实例首份就绪状态即入点,不留旧位置、不跳不重复', async () => {
  const segments = [seg('s1', 7, 26.4, 34.2), seg('s2', 9, 3, 8)];
  const h = harness(segments, { durations: new Map([[7, 121], [9, 90]]), suggestion: [5, 13], openTicks: 3 });
  await h.start();
  await h.run(300);
  expect(h.outside().map(s => [s.clipId, s.truePos])).toEqual([]);
  // 新素材上没有一拍是「在播 + 位置还在入点之前」(旧版本这里是 pos 0.08、paused=false)。
  expect(h.samples.filter(s => s.clipId === 9 && !s.truePaused && s.truePos < 3 - TOL)).toEqual([]);
  // 不跳段、不重复 advance。
  expect(h.samples.map(s => s.index).filter((v, i, a) => v !== a[i - 1])).toEqual([0, 1]);
  expect(h.seeks().filter(v => v === 3).length).toBeLessThanOrEqual(1);
  const firstReady = h.player.samples.find(s => s.clipId === 9 && s.phase === 'ready');
  expect(firstReady?.pos).toBeCloseTo(3, 5);
  expect(firstReady?.paused).toBe(true);
  expect(h.player.samples.filter(s => s.clipId === 9 && s.pos < 3 - 0.5 / 25)).toEqual([]);
});

it('§8C 刻度与指针:完整素材刻度,绿框跟随活动选段,指针连续推进,越界不靠 clamp 遮', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(300);
  // 越界旗一次都不能亮 —— 真越界了这里就红,而不是被 ratioAt clamp 成 100% 看不出来。
  expect(h.samples.filter(s => s.outOfRange)).toEqual([]);
  // R25:完整素材刻度下,绿框按选段绝对入点定位。
  expect(h.samples.filter(s => s.bandLeft !== null).every(s => Math.abs(Number.parseFloat(s.bandLeft!) - s.segIn / 121 * 100) < 1e-6)).toBe(true);
  // 段内指针连续不回头,且从段首走到段尾。
  const first = h.samples.filter(s => s.index === 0 && !s.truePaused && s.headPct !== null).map(s => s.headPct!);
  expect(first.every((v, i) => i === 0 || v >= first[i - 1]! - 1e-9)).toBe(true);
  expect(Math.max(...first)).toBeGreaterThan(34 / 121 * 100);
  expect(Math.min(...first)).toBeLessThan(27 / 121 * 100);
});

it('§8C 暂停后指针与时间码停在同一位置,继续后接着走', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(40);
  await h.call(() => h.controller.pause());
  const frozen = h.samples.at(-1)!;
  await h.run(20);
  const still = h.samples.at(-1)!;
  expect([still.pos, still.headPct]).toEqual([frozen.pos, frozen.headPct]);
  await h.call(() => h.controller.resume());
  await h.run(20);
  expect(h.samples.at(-1)!.pos).toBeGreaterThan(frozen.pos);
  expect(h.outside()).toEqual([]);
});

it('§8D 手动上一段 / 下一段走同一条路:各自 seek 到自己的入点,不越界', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(10);
  await h.call(() => h.controller.next());
  await h.run(10);
  expect(h.samples.at(-1)!.index).toBe(1);
  await h.call(() => h.controller.previous());
  await h.run(10);
  expect(h.samples.at(-1)!.index).toBe(0);
  expect(h.outside()).toEqual([]);
  expect(h.seeks().filter(v => v === 39.4).length).toBeGreaterThanOrEqual(1);
  expect(h.seeks().filter(v => v === 26.4).length).toBeGreaterThanOrEqual(2);
});

it('§8D 快速连续切段:迟到的回调不把播放头写回旧段', async () => {
  const h = harness([...A_SEGMENTS, seg('s3', 9, 12, 18)], {
    durations: new Map([[7, 121], [9, 90]]), suggestion: [5, 13], seekLandTicks: 2, openTicks: 2,
  });
  await h.start();
  await act(async () => { h.controller.next(); h.controller.next(); });
  await h.run(200);
  expect(h.outside().map(s => [s.clipId, s.index, s.truePos])).toEqual([]);
  expect(h.samples.at(-1)!.index).toBe(2);
});

it('§8D 停连播必须真的停住播放器:走带没就绪也要发 pause,不留原片自己往下跑', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(20);
  expect(h.player.paused).toBe(false);
  // 换素材那一拍走带的 clip_id 对不上 —— 以前 pause 会在这里静默跳过,原片一路播到片尾。
  h.player.clipId = 999;
  await h.run(1);
  const before = h.player.commands.filter(c => c.cmd.type === 'pause').length;
  await h.call(() => h.controller.stop());
  expect(h.player.commands.filter(c => c.cmd.type === 'pause').length).toBeGreaterThan(before);
  expect(h.player.commands.filter(c => c.cmd.type === 'pause').length).toBeGreaterThan(0);
  expect(h.player.paused).toBe(true);
});

it('§9 连播释放(镜头带开始编辑)不撤围栏:素材播到 out 就停,按播放才自由播', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(30);
  expect(h.player.paused).toBe(false);
  // 镜头带一开始编辑 → releasePlaythrough():连播停,素材继续播(0.11.3 语义)。
  await h.call(() => releasePlaythrough());
  expect(h.controller.phase).toBe('idle');
  expect(h.player.paused).toBe(false);
  // 一路放下去,必须停在 activeSegment.out,绝不溜进 (34.2, 39.4)。
  await h.run(200);
  expect(h.player.paused).toBe(true);
  // R24:真 mpv 停在 end 之前的最后一帧(34.16 @25fps),不是 end 本身;fakePlayer 已按真机改。
  expect(h.player.pos).toBeGreaterThanOrEqual(34.2 - 1 / 25 - 1e-9);
  expect(h.player.pos).toBeLessThanOrEqual(34.2);
  expect(h.player.samples.filter(s => !s.paused && s.pos > 34.2 + TOL)).toEqual([]);
  // 按播放 = 人工开播:围栏撤掉,从这里起自由播,可以越过 out。
  await act(async () => { await h.transport.seekTo(34.2); });
  await h.call(() => { void h.transport.play(); });
  await h.run(30);
  expect(h.player.pos).toBeGreaterThan(35.5);
});

it('§9 R23-N4(真机):释放时那一下点击自带的跟随 seek 不许把素材放进未选区间', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start();
  await h.run(20);
  // 镜头带 ⌘ 点镜块 = 多选(释放连播)+ 跟随 seek 到卡片上那个点 —— 同一下手势里两件事。
  // 真机上那一下把播放头甩到 51.0(另一个镜头的范围),然后一路自由播到片尾 59.96。
  await h.call(() => releasePlaythrough());
  await act(async () => { await h.transport.seekTo(30.0); });
  await h.run(200);
  // 新规矩:释放之后任何一次 seek 都不自动开播 —— 停在目标上等用户按播放。
  expect(h.player.paused).toBe(true);
  expect(h.player.pos).toBeCloseTo(30.0, 2);
  expect(h.player.samples.filter(s => !s.paused && (s.pos > 34.2 + TOL || (s.pos > 12 && s.pos < 26.4 - TOL)))).toEqual([]);
  // 用户按播放才自由播。
  await h.call(() => { void h.transport.play(); });
  await h.run(30);
  expect(h.player.pos).toBeGreaterThan(31);
});

async function dragTrack(move = true) {
  const track = document.querySelector<HTMLElement>('.scrubber-r22-track')!;
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100, bottom: 20 } as DOMRect);
  // jsdom has no PointerEvent; mouse events retain the pointer coordinates React reads.
  await act(async () => {
    fireEvent(track, new MouseEvent('pointerdown', { bubbles: true, clientX: 30, button: 0 }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    if (move) fireEvent(track, new MouseEvent('pointermove', { bubbles: true, clientX: 40 }));
    fireEvent(track, new MouseEvent('pointerup', { bubbles: true, clientX: move ? 40 : 30 }));
  });
}

it.each([true, false])('P-1(a) 释放后真轨道手势 move=%s 松手不得开播;显式播放才解除等待(基线红)', async move => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start(); await h.run(10);
  await h.call(() => releasePlaythrough());
  expect(h.player.paused).toBe(false);
  await dragTrack(move); await h.run(3);
  const commands = h.player.commands.map(c => c.cmd.type);
  expect(commands.slice(commands.lastIndexOf('seek_abs') + 1)).not.toContain('play');
  expect(h.player.paused).toBe(true);
  await h.call(() => { void h.transport.play(); });
  expect(h.player.paused).toBe(false);
  await dragTrack(); await h.run(3);
  expect(h.player.paused).toBe(false);
});

it('P-1(b) 普通播放拖轨道松手照常继续(基线绿)', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.call(() => { void h.transport.play(); });
  await dragTrack(); await h.run(3);
  expect(h.player.commands.at(-1)?.cmd.type).toBe('play');
  expect(h.player.paused).toBe(false);
});

it('R25 连播中段外拖轨道退出选段并暂停,松手不自动播放', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start(); await h.run(10);
  await dragTrack(); await h.run(3);
  expect(h.controller.active).toBe(false);
  expect(h.player.paused).toBe(true);
});

it('P-2 每一拍 AX 单对象读数含同段号与秒数(基线红)', async () => {
  const h = harness(A_SEGMENTS, A_OPTIONS);
  await h.start(); await h.run(300);
  const paired = h.samples.filter(s => s.bandLeft !== null);
  expect(paired.length).toBeGreaterThan(100);
  for (const s of paired) {
    expect(s.axText).toContain(`第 ${s.index + 1}/2 段`);
    expect(s.axValue).toBeGreaterThanOrEqual(s.segIn - 1 / 25);
    expect(s.axValue).toBeLessThanOrEqual(s.segOut + 1 / 25);
  }
});

it('R24 帧边界出点:围栏停在 out − 1 帧(浮点够不到 out − 1/fps)也要接下一段,不许卡在第一段末帧', async () => {
  // 真机 0.11.4 / R24 QA 包实测:I/O 打点保存的段 out=12.48(帧边界),mpv 停在 12.44,连播永远停在 1/3。
  const h = harness([seg('f1', 7, 4.48, 12.48), seg('f2', 7, 46.48, 54.48)], { durations: new Map([[7, 60]]) });
  await h.start(); await h.run(400);
  expect(h.samples.some(s => s.index === 1 && s.truePos >= 46.48 - TOL)).toBe(true);
  expect(h.controller.phase).toBe('done');
});
