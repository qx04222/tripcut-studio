// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import { REVEAL_IN_FINDER_LABEL } from "../copy";
import { __resetWorkspaceForTests } from "../WorkspaceStore";
import { PoolClipContextMenu } from "../ClipMenu";
import { __resetQuickExportForTests, takePendingQuickSelection } from "./quickExportModel";

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
});
afterEach(cleanup);

/** R16 P2-7:素材卡菜单(车道 A 的 `PoolClipContextMenu`)里的「在 Finder 中显示」——规格 §1 顺序在「导出所选」之后、「移除素材」之前;多选时显示右键点中的那一张。 */
describe("卡片菜单「在 Finder 中显示」", () => {
  it("菜单顺序:… 导出所选 → 在 Finder 中显示 → 移除素材;点了调 revealClip(点中的那张),不开导出抽屉", async () => {
    apiMock.revealClip.mockResolvedValue(undefined);
    render(
      <div className="media-pool">
        <div role="grid" aria-label="媒体池">
          <div role="row">
            <div role="gridcell" id="pool-clip-3" aria-label="三" />
            <div role="gridcell" id="pool-clip-9" aria-label="九" />
          </div>
        </div>
        <PoolClipContextMenu multiSelection={[3, 9]} />
      </div>,
    );
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: "九" }), { clientX: 40, clientY: 50 });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["收藏", "拒绝", "清除评级", "加入镜头带", "导出所选", REVEAL_IN_FINDER_LABEL, "移除素材"]);
    await act(async () => {
      items[5]!.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMock.revealClip).toHaveBeenCalledWith(9));
    expect(takePendingQuickSelection()).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
