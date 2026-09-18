// @vitest-environment jsdom
// R13 §1 / §2(车道 A):设置 → 「快捷键」分区 —— 预设下拉、动作表、录制新键、冲突提示、恢复默认。
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { __resetKeymapForTests, getKeymap } from "./keymapStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
import { __setShowAllFeaturesForTests } from "./showAllFeatures";

async function openKeymap(): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    const button = screen.getByRole("button", { name: "设置" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("设置已从本地项目载入"));
  await act(async () => {
    within(dialog).getByRole("tab", { name: "快捷键" }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

function rowKeys(panel: HTMLElement, action: string): string {
  const row = panel.querySelector<HTMLElement>(`[data-keymap-action="${action}"]`)!;
  return [...row.querySelectorAll("kbd")].map((kbd) => kbd.textContent).join(" / ");
}

beforeEach(() => {
  // R19 P-05:这份文件描述的是「显示全部功能」打开后的形态(旅程 / 地点卡 / 模板 / 技术检查 / 快捷键 / 性能 / 云端补镜都在);默认态在 showAllFeaturesR19.test。
  __setShowAllFeaturesForTests(true);
  __resetWorkspaceForTests();
  __resetKeymapForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("R13 设置 → 快捷键", () => {
  it("tab「快捷键」、table「快捷键表」;默认剪映预设,导出 ⌘E、逐帧 ← / ,;分割两行灰且不可改", async () => {
    const panel = await openKeymap();
    const table = within(panel).getByRole("table", { name: "快捷键表" });
    expect(within(panel).getByRole("combobox", { name: "键位预设" })).toHaveProperty("value", "jianying");
    expect(within(table).getAllByRole("rowgroup").length).toBeGreaterThan(3);
    expect(rowKeys(panel, "export")).toBe("⌘E");
    expect(rowKeys(panel, "frame-back")).toBe("← / ,");
    expect(rowKeys(panel, "jump-forward-5s")).toBe("⇧→");
    const split = panel.querySelector<HTMLElement>('[data-keymap-action="split-before"]')!;
    expect(split.className).toContain("is-pending");
    expect(split.textContent).toContain("到剪映里做");
    expect(within(split).getByRole("button", { name: "修改「分割(向前)」" })).toHaveProperty("disabled", true);
    expect(within(panel).getByRole("button", { name: "恢复默认" })).toHaveProperty("disabled", true);
  });

  it("切到 Premiere Pro:写 keymap.preset、导出变 ⌘M、进程内快照同步;恢复默认写回剪映并清空自定义", async () => {
    const panel = await openKeymap();
    await act(async () => {
      fireEvent.change(within(panel).getByRole("combobox", { name: "键位预设" }), { target: { value: "premiere" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("keymap.preset", "premiere"));
    expect(rowKeys(panel, "export")).toBe("⌘M");
    expect(getKeymap().preset).toBe("premiere");
    await act(async () => {
      within(panel).getByRole("button", { name: "恢复默认" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("keymap.preset", "jianying"));
    expect(apiMocks.setSetting).toHaveBeenCalledWith("keymap.custom", "");
    expect(rowKeys(panel, "export")).toBe("⌘E");
  });

  it("「修改」录制:按 ⇧G 后收藏变 ⇧G、预设变自定义、custom JSON 记住底表;录制中 ⌘E 不会开导出抽屉;Esc 取消", async () => {
    const panel = await openKeymap();
    const edit = within(panel).getByRole("button", { name: "修改「收藏」" });
    await act(async () => {
      edit.focus();
      edit.click();
      await Promise.resolve();
    });
    expect(within(panel).getByRole("button", { name: /正在录制「收藏」/ })).toBeTruthy();
    // 只按修饰键不算;⌘E 是录进来而不是被壳吃掉。
    fireEvent.keyDown(edit, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(within(panel).getByRole("button", { name: /正在录制「收藏」/ })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(edit, { key: "G", code: "KeyG", shiftKey: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.setSetting).toHaveBeenCalledWith("keymap.preset", "custom"));
    const customCall = apiMocks.setSetting.mock.calls.find(([key]) => key === "keymap.custom")!;
    expect(JSON.parse(customCall[1] as string)).toEqual({ base: "jianying", overrides: { favorite: ["Shift+g"] } });
    expect(rowKeys(panel, "favorite")).toBe("⇧G");
    expect(within(panel).getByRole("combobox", { name: "键位预设" })).toHaveProperty("value", "custom");

    const editReject = within(panel).getByRole("button", { name: "修改「拒绝」" });
    await act(async () => {
      editReject.focus();
      editReject.click();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(editReject, { key: "e", code: "KeyE", metaKey: true });
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
    expect(rowKeys(panel, "reject")).toBe("⌘E");

    const editStar = within(panel).getByRole("button", { name: "修改「打 1 星」" });
    await act(async () => {
      editStar.focus();
      editStar.click();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(editStar, { key: "Escape", code: "Escape" });
      await Promise.resolve();
    });
    expect(within(panel).getByRole("button", { name: "修改「打 1 星」" })).toBeTruthy();
    expect(rowKeys(panel, "star-1")).toBe("1");
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
  });

  it("撞键即时提示:把「拒绝」录成 F,收藏与拒绝两行都标冲突(role=alert)", async () => {
    const panel = await openKeymap();
    const editReject = within(panel).getByRole("button", { name: "修改「拒绝」" });
    await act(async () => {
      editReject.focus();
      editReject.click();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(editReject, { key: "f", code: "KeyF" });
      await Promise.resolve();
    });
    const reject = panel.querySelector<HTMLElement>('[data-keymap-action="reject"]')!;
    const favorite = panel.querySelector<HTMLElement>('[data-keymap-action="favorite"]')!;
    expect(reject.className).toContain("is-conflict");
    expect(within(reject).getByRole("alert").textContent).toContain("与「收藏」撞键");
    expect(within(favorite).getByRole("alert").textContent).toContain("与「拒绝」撞键");
    // 监视器的 L(常速播放)与媒体池的 L(锁定候选)不同栏,不算冲突。
    expect(panel.querySelector('[data-keymap-action="lock-stack"]')!.className).not.toContain("is-conflict");
  });
});
