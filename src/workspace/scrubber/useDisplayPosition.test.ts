import { describe, expect, it } from 'vitest';
import { extrapolatePosition, type DisplayPositionInput } from './useDisplayPosition';
const playing: DisplayPositionInput = { pos: 5, duration: 10, ready: true, paused: false, rate: 1 };
describe('R27 显示位置纯函数', () => {
  it('按倍速推进,时钟倒退不低于状态位置', () => {
    expect(extrapolatePosition(playing, 40)).toBeCloseTo(5.04);
    expect(extrapolatePosition({ ...playing, rate: 2 }, 40)).toBeCloseTo(5.08);
    expect(extrapolatePosition({ ...playing, rate: 0.5 }, 40)).toBeCloseTo(5.02);
    expect(extrapolatePosition(playing, -40)).toBe(5);
  });
  it('上限同时受围栏与时长限制,已越界的真实状态保留作诊断', () => {
    expect(extrapolatePosition({ ...playing, end: 5.03 }, 40)).toBe(5.03);
    expect(extrapolatePosition({ ...playing, end: 20 }, 9000)).toBe(10);
    expect(extrapolatePosition(playing, 9000)).toBe(10);
    expect(extrapolatePosition({ ...playing, end: 4 }, 40)).toBe(5);
  });
  it.each([{ paused: true }, { ready: false }, { seeking: true }, { rewinding: true }, { switching: true }])('暂停或未稳定时原样返回 pos: %o', blocked => {
    expect(extrapolatePosition({ ...playing, ...blocked }, 40)).toBe(5);
  });
});
