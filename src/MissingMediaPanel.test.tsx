// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MissingMediaPanel } from "./MissingMediaPanel";
const api = vi.hoisted(() => ({ listMissingClips: vi.fn(), pickRelinkFolder: vi.fn(), relinkVolume: vi.fn() }));
vi.mock("./api", () => api);
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const click = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};

it("lists missing clips grouped by volume", async () => {
  api.listMissingClips.mockResolvedValue([
    { clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "2026-09-01T00:00:00Z" },
    { clip_id: 2, file_name: "B.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/B.MOV", missing_since: "2026-09-01T00:00:00Z" },
    { clip_id: 3, file_name: "C.MOV", volume_uuid: "vol-2", volume_label: null, rel_path: "DCIM/C.MOV", missing_since: "2026-09-01T00:00:00Z" },
  ]);
  await act(async () => root.render(<MissingMediaPanel />));
  expect(host.textContent).toContain("SD Card");
  expect(host.textContent).toContain("2 个文件缺失");
  expect(host.textContent).toContain("vol-2");
  expect(host.textContent).toContain("A.MOV");
  expect(host.textContent).toContain("C.MOV");
});

it("renders nothing when there is no missing media", async () => {
  api.listMissingClips.mockResolvedValue([]);
  await act(async () => root.render(<MissingMediaPanel />));
  expect(host.querySelector(".missing-media-panel")).toBeNull();
});

it("relinks a volume and shows a summary with rejected file names", async () => {
  api.listMissingClips.mockResolvedValueOnce([
    { clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "2026-09-01T00:00:00Z" },
    { clip_id: 2, file_name: "B.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/B.MOV", missing_since: "2026-09-01T00:00:00Z" },
  ]).mockResolvedValueOnce([
    { clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "2026-09-01T00:00:00Z" },
  ]);
  api.pickRelinkFolder.mockResolvedValue("/Volumes/NewCard");
  api.relinkVolume.mockResolvedValue({ relinked: 1, rejected: ["A.MOV"], still_missing: 0 });

  await act(async () => root.render(<MissingMediaPanel />));
  await click("选择新位置");

  expect(api.relinkVolume).toHaveBeenCalledWith("vol-1", "/Volumes/NewCard");
  expect(host.textContent).toContain("重绑 1");
  expect(host.textContent).toContain("拒绝 1");
  expect(host.textContent).toContain("A.MOV");
  expect(api.listMissingClips).toHaveBeenCalledTimes(2);
});

it("does not call relinkVolume when the folder picker is cancelled", async () => {
  api.listMissingClips.mockResolvedValue([
    { clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "2026-09-01T00:00:00Z" },
  ]);
  api.pickRelinkFolder.mockResolvedValue(null);
  await act(async () => root.render(<MissingMediaPanel />));
  await click("选择新位置");
  expect(api.relinkVolume).not.toHaveBeenCalled();
});
