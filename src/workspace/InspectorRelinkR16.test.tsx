// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** R16 P1-7:检查器头缺失素材的「找到它…」与缺失页同入口(pick_relink_file → relink_clip)。 */
const apiMocks = vi.hoisted(() => ({
  pickRelinkFile: vi.fn(),
  relinkClip: vi.fn(),
  getClipsRevision: vi.fn().mockResolvedValue("r"),
  listClips: vi.fn().mockResolvedValue([]),
  listShotStacks: vi.fn().mockResolvedValue([]),
  getStoryboard: vi.fn().mockResolvedValue({ chapters: [], candidates: [], items: [] }),
  listStoryGaps: vi.fn().mockResolvedValue([]),
  listClipDimensions: vi.fn().mockResolvedValue([]),
  listAssetSafety: vi.fn().mockResolvedValue([]),
  getCurrentEpisode: vi.fn().mockResolvedValue({ id: 1, status: "active" }),
}));
vi.mock("../api", () => apiMocks);

import { InspectorRelink } from "./InspectorRelink";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("InspectorRelink(R16 P1-7)", () => {
  it("不缺失时不渲染", () => {
    const { container } = render(<InspectorRelink clipId={1} fileName="A.MOV" missing={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("缺失时给「找到它…」;取消不调 relinkClip;选中后调 relinkClip 并报已找到", async () => {
    apiMocks.pickRelinkFile.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/New/A.MOV");
    apiMocks.relinkClip.mockResolvedValue({ clip_id: 1, file_name: "A.MOV", volume_uuid: "NEW" });
    render(<InspectorRelink clipId={1} fileName="A.MOV" missing />);
    const button = screen.getByRole("button", { name: "找到 A.MOV" });
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.pickRelinkFile).toHaveBeenCalledWith("A.MOV"));
    expect(apiMocks.relinkClip).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(apiMocks.relinkClip).toHaveBeenCalledWith(1, "/Volumes/New/A.MOV"));
    await screen.findByText(/已找到/);
  });

  it("后端拒绝(时长对不上)原话进提示", async () => {
    apiMocks.pickRelinkFile.mockResolvedValue("/Volumes/New/A.MOV");
    apiMocks.relinkClip.mockRejectedValue(new Error("时长对不上:原片 12.0 秒,选中的文件 13.0 秒"));
    render(<InspectorRelink clipId={1} fileName="A.MOV" missing />);
    fireEvent.click(screen.getByRole("button", { name: "找到 A.MOV" }));
    await screen.findByText(/时长对不上/);
  });
});
