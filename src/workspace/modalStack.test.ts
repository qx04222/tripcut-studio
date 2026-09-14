import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetModalStackForTests,
  isAnyModalOpen,
  isPlayerOccluded,
  isTopModal,
  popModal,
  popOccluder,
  pushModal,
  pushOccluder,
  subscribeModalStack,
} from "./modalStack";

afterEach(() => __resetModalStackForTests());

describe("subscribeModalStack", () => {
  it("每次 push / pop 都通知订阅者,退订后不再通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeModalStack(listener);
    const a = {};
    const b = {};

    pushModal(a);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isAnyModalOpen()).toBe(true);

    pushModal(b);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isTopModal(b)).toBe(true);

    popModal(b);
    popModal(a);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(isAnyModalOpen()).toBe(false);

    unsubscribe();
    pushModal(a);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("重复 push 同一个 token 或 pop 不在栈里的 token 不触发通知", () => {
    const listener = vi.fn();
    subscribeModalStack(listener);
    const a = {};
    pushModal(a);
    pushModal(a);
    popModal({});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("订阅者在通知时读到的是变化后的栈", () => {
    const seen: boolean[] = [];
    subscribeModalStack(() => seen.push(isAnyModalOpen()));
    const a = {};
    pushModal(a);
    popModal(a);
    expect(seen).toEqual([true, false]);
  });
});

/** Y-01/Y-02:首页与引导气泡不是模态(不抢 Esc),但同样要让原生视频层让位 —— 单独一组「遮挡者」。 */
describe("pushOccluder / isPlayerOccluded", () => {
  it("遮挡者不进模态栈(Esc 语义不变),但 isPlayerOccluded 为真并通知订阅者", () => {
    const listener = vi.fn();
    subscribeModalStack(listener);
    const home = {};
    pushOccluder(home);
    expect(isAnyModalOpen()).toBe(false);
    expect(isTopModal(home)).toBe(false);
    expect(isPlayerOccluded()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    pushOccluder(home);
    expect(listener).toHaveBeenCalledTimes(1);
    popOccluder(home);
    expect(isPlayerOccluded()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    popOccluder(home);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("模态层与遮挡者任一在场都算遮挡", () => {
    const drawer = {};
    const bubble = {};
    pushModal(drawer);
    pushOccluder(bubble);
    popModal(drawer);
    expect(isPlayerOccluded()).toBe(true);
    popOccluder(bubble);
    expect(isPlayerOccluded()).toBe(false);
  });
});
