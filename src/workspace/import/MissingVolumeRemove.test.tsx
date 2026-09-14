// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
vi.mock("../../api", () => apiMock);

import { __resetClipRemovalForTests } from "../clipRemoval";
import { ClipRemovalHost } from "../ClipRemovalHost";
import { REMOVAL_CONFIRM_BUTTON, REMOVAL_CONFIRM_LABEL, VOLUME_GONE_LABEL } from "../copy";
import { __resetToastsForTests } from "../ui/toastStore";
import { __resetWorkspaceForTests } from "../WorkspaceStore";
import { ImportMissingTab } from "./ImportMissingTab";
import { volumeGoneTitle } from "./MissingVolumeRemove";

const missing = (clipId: number, volume: string, label: string | null) => ({
  clip_id: clipId, file_name: `c${clipId}.mov`, volume_uuid: volume, volume_label: label, rel_path: `c${clipId}.mov`, missing_since: "2026-09-14",
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  __resetClipRemovalForTests();
  __resetToastsForTests();
  __resetWorkspaceForTests();
  apiMock.listMissingClips.mockResolvedValue([missing(1, "V-A", "CARD-A"), missing(2, "V-A", "CARD-A"), missing(3, "V-B", null)]);
  apiMock.previewImportRemoval.mockResolvedValue({ clips: 2, favorites: 0, selections: 1, cache_entries: 2 });
  apiMock.removeImportedMaterial.mockResolvedValue(2);
});
afterEach(cleanup);

describe("R16 P2-9:缺失页「这个盘不会再回来了…」", () => {
  it("每个卷组一颗;点了带这个卷的 clip_ids 走移除预览,标题说清哪个盘几条;确认后调命令并重取缺失清单", async () => {
    render(
      <>
        <ImportMissingTab />
        <ClipRemovalHost />
      </>,
    );
    const buttons = await screen.findAllByRole("button", { name: "这个盘不会再回来了" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe(VOLUME_GONE_LABEL);
    expect(apiMock.listMissingClips).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    const dialog = await screen.findByRole("alertdialog", { name: REMOVAL_CONFIRM_LABEL });
    expect(apiMock.previewImportRemoval).toHaveBeenCalledWith({ batch_id: null, clip_ids: [1, 2], all: false });
    expect(dialog.textContent).toContain("移除「CARD-A」上的 2 条素材");
    expect(dialog.textContent).toContain("将移除 2 条素材");
    apiMock.listMissingClips.mockResolvedValue([missing(3, "V-B", null)]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: REMOVAL_CONFIRM_BUTTON }));
    });
    await waitFor(() => expect(apiMock.removeImportedMaterial).toHaveBeenCalledWith({ batch_id: null, clip_ids: [1, 2], all: false }));
    await waitFor(() => expect(apiMock.listMissingClips).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "这个盘不会再回来了" })).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("没有卷标时标题用卷 id", () => {
    expect(volumeGoneTitle({ volumeLabel: null, volumeUuid: "V-B", clips: [missing(3, "V-B", null)] })).toBe("移除「V-B」上的 1 条素材");
  });
});
