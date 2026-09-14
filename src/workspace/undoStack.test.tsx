// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import { NOTHING_TO_UNDO_TOAST, undoneToast } from "./copy";
import { __resetHomeForTests } from "./homeStore";
import { __resetModalStackForTests, pushModal } from "./modalStack";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { __resetUndoForTests, canUndo, dropUndo, pushUndo, runUndo, runUndoById } from "./undoStack";
import { pushStoryUndo } from "./useBandDrag";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

function press(init: KeyboardEventInit & { key: string }): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  vi.clearAllMocks();
  __resetUndoForTests();
  __resetToastsForTests();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  __resetHomeForTests();
});
afterEach(cleanup);

describe("R16 P2-2:全局撤销栈", () => {
  it("后进先出;runUndo 回那一条并执行 undo;空栈回 null", async () => {
    const order: string[] = [];
    pushUndo({ label: "甲", undo: async () => void order.push("甲") });
    pushUndo({ label: "乙", undo: async () => void order.push("乙") });
    expect(canUndo()).toBe(true);
    expect((await runUndo())?.label).toBe("乙");
    expect((await runUndo())?.label).toBe("甲");
    expect(await runUndo()).toBeNull();
    expect(order).toEqual(["乙", "甲"]);
  });

  it("runUndoById 只撤那一条;已被 ⌘Z 撤过的 id 回 false,不重复执行;dropUndo 拿掉不执行", async () => {
    const ran: string[] = [];
    const a = pushUndo({ label: "a", undo: async () => void ran.push("a") });
    const b = pushUndo({ label: "b", undo: async () => void ran.push("b") });
    const c = pushUndo({ label: "c", undo: async () => void ran.push("c") });
    expect(await runUndoById(a)).toBe(true);
    expect(await runUndo()).toMatchObject({ label: "c" });
    expect(await runUndoById(c)).toBe(false);
    dropUndo(b);
    expect(canUndo()).toBe(false);
    expect(ran).toEqual(["a", "c"]);
  });

  it("镜头带条目同时只留最新一条(后端 undo_story_change 只认最近一次)", async () => {
    pushStoryUndo("调整顺序");
    pushStoryUndo("加入镜头带");
    expect((await runUndo())?.label).toBe("加入镜头带");
    expect(apiMock.undoStoryChange).toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
  });

  it("壳上按 ⌘Z:弹栈顶一条并 toast「已撤销 · …」;空栈 toast「没有可撤销的操作」;模态开着不抢", async () => {
    render(<WorkspaceShell />);
    press({ key: "z", code: "KeyZ", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getToastSnapshot()?.text).toBe(NOTHING_TO_UNDO_TOAST);

    const ran: string[] = [];
    pushUndo({ label: "移到别的章", undo: async () => void ran.push("x") });
    press({ key: "z", code: "KeyZ", metaKey: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ran).toEqual(["x"]);
    expect(getToastSnapshot()?.text).toBe(undoneToast("移到别的章"));
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("已撤销"))).toBe(true);

    pushUndo({ label: "不该被撤", undo: async () => void ran.push("y") });
    pushModal({});
    press({ key: "z", code: "KeyZ", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(ran).toEqual(["x"]);
    expect(canUndo()).toBe(true);
  });
});
