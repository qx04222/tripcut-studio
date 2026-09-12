import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetModalStackForTests,
  isAnyModalOpen,
  isTopModal,
  popModal,
  pushModal,
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
