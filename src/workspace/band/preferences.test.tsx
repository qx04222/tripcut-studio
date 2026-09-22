// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../api", () => ({ getSettings: vi.fn(async () => ({})), setSetting: vi.fn(async () => undefined) }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../ui/Toast", () => ({ showToast: (text: string) => toasts.push(text) }));
const undoStack = vi.hoisted(() => ({ pushed: 0 }));
vi.mock("../undoStack", () => ({ pushUndo: () => { undoStack.pushed += 1; return 1; }, peekUndo: () => null, runUndoById: async () => false }));
import { setSetting } from "../../api";
import { useBandPreferences } from "./useBandPreferences";
afterEach(() => { cleanup(); vi.clearAllMocks(); toasts.length = 0; undoStack.pushed = 0; });
it("R22-C 决策:缩放 / 折叠 / 角标静默按集保存 —— 成功不弹 toast、不进 ⌘Z 栈", async () => {
  const { result } = renderHook(() => useBandPreferences(1, false));
  await act(async () => undefined);
  act(() => { result.current.zoom(0.75); result.current.toggleFold("chapter:1"); result.current.toggleBadges(); });
  await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(3));
  expect(JSON.parse(vi.mocked(setSetting).mock.lastCall![1])).toEqual({ zoom: 0.75, folded: ["chapter:1"], badges: true });
  expect(toasts).toEqual([]);
  expect(undoStack.pushed).toBe(0);
});
it("a queued save failure rolls back to the last successful persisted value and says so", async () => {
  const { result } = renderHook(() => useBandPreferences(1, false));
  await act(async () => undefined);
  act(() => { result.current.zoom(0.75); });
  await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(1));
  vi.mocked(setSetting).mockRejectedValueOnce(new Error("disk full"));
  act(() => { result.current.toggleFold("chapter:1"); });
  await waitFor(() => expect(toasts).toHaveLength(1));
  expect(toasts[0]).toContain("没成功");
  expect(result.current.value).toEqual({ zoom: 0.75, folded: [], badges: false });
});
