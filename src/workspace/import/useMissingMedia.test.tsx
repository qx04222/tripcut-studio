// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 四例逐条复制 `src/MissingMediaPanel.test.tsx` 的语义:分组 / 空 / 重绑摘要 / 取消不调 relink。
const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
vi.mock("../../api", () => apiMock);

import { useMissingMedia } from "./useMissingMedia";

const clip = (id: number, name: string, vol: string, label: string | null) => ({
  clip_id: id, file_name: name, volume_uuid: vol, volume_label: label, rel_path: `DCIM/${name}`, missing_since: "2026-09-01T00:00:00Z",
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMissingMedia(迁自 MissingMediaPanel.test)", () => {
  it("按卷分组,卷标为空时用 uuid", async () => {
    apiMock.listMissingClips.mockResolvedValue([
      clip(1, "A.MOV", "vol-1", "SD Card"), clip(2, "B.MOV", "vol-1", "SD Card"), clip(3, "C.MOV", "vol-2", null),
    ]);
    const { result } = renderHook(() => useMissingMedia());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.clips).toHaveLength(3);
    expect(result.current.groups.map((g) => [g.volumeUuid, g.volumeLabel, g.clips.length])).toEqual([
      ["vol-1", "SD Card", 2], ["vol-2", null, 1],
    ]);
  });

  it("没有缺失素材时 groups 为空", async () => {
    apiMock.listMissingClips.mockResolvedValue([]);
    const { result } = renderHook(() => useMissingMedia());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.groups).toEqual([]);
  });

  it("重绑一卷后记录摘要并重新拉列表", async () => {
    apiMock.listMissingClips
      .mockResolvedValueOnce([clip(1, "A.MOV", "vol-1", "SD Card"), clip(2, "B.MOV", "vol-1", "SD Card")])
      .mockResolvedValueOnce([clip(1, "A.MOV", "vol-1", "SD Card")]);
    apiMock.pickRelinkFolder.mockResolvedValue("/Volumes/NewCard");
    apiMock.relinkVolume.mockResolvedValue({ relinked: 1, rejected: ["A.MOV"], still_missing: 0 });
    const { result } = renderHook(() => useMissingMedia());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.relink("vol-1"); });
    expect(apiMock.relinkVolume).toHaveBeenCalledWith("vol-1", "/Volumes/NewCard");
    expect(result.current.results["vol-1"]).toEqual({ relinked: 1, rejected: ["A.MOV"], still_missing: 0 });
    expect(apiMock.listMissingClips).toHaveBeenCalledTimes(2);
    expect(result.current.clips).toHaveLength(1);
    expect(result.current.busy).toBeNull();
  });

  it("取消选位置不调 relinkVolume;失败进 notice", async () => {
    apiMock.listMissingClips.mockResolvedValue([clip(1, "A.MOV", "vol-1", "SD Card")]);
    apiMock.pickRelinkFolder.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/X");
    const { result } = renderHook(() => useMissingMedia());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.relink("vol-1"); });
    expect(apiMock.relinkVolume).not.toHaveBeenCalled();
    apiMock.relinkVolume.mockRejectedValueOnce(new Error("卷不可写"));
    await act(async () => { await result.current.relink("vol-1"); });
    expect(result.current.notice).toContain("卷不可写");
  });

  // R16 P1-7:每条「找到它…」→ 文件面板(标题带文件名)→ relinkClip;成功后重拉清单、记一句提示;取消不调。
  it("找到它:选中文件后调 relinkClip 并重新拉列表;取消不调;失败进 notice", async () => {
    apiMock.listMissingClips
      .mockResolvedValueOnce([clip(1, "A.MOV", "vol-1", "SD Card"), clip(2, "B.MOV", "vol-1", "SD Card")])
      .mockResolvedValueOnce([clip(2, "B.MOV", "vol-1", "SD Card")]);
    apiMock.pickRelinkFile.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/New/A.MOV");
    apiMock.relinkClip.mockResolvedValue({ clip_id: 1, file_name: "A.MOV", volume_uuid: "NEW" });
    const { result } = renderHook(() => useMissingMedia());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.relinkOne(1, "A.MOV"); });
    expect(apiMock.pickRelinkFile).toHaveBeenCalledWith("A.MOV");
    expect(apiMock.relinkClip).not.toHaveBeenCalled();
    await act(async () => { await result.current.relinkOne(1, "A.MOV"); });
    expect(apiMock.relinkClip).toHaveBeenCalledWith(1, "/Volumes/New/A.MOV");
    expect(result.current.clips.map((c) => c.clip_id)).toEqual([2]);
    expect(result.current.notice).toContain("A.MOV");
    expect(result.current.busyClip).toBeNull();
    apiMock.relinkClip.mockRejectedValueOnce(new Error("时长对不上"));
    apiMock.pickRelinkFile.mockResolvedValueOnce("/Volumes/New/B.MOV");
    await act(async () => { await result.current.relinkOne(2, "B.MOV"); });
    expect(result.current.notice).toContain("时长对不上");
  });
});
