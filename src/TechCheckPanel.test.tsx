// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipAudioTrack, ClipListItem } from "./api";

const apiMock = vi.hoisted(() => ({
  listAudioTracks: vi.fn(),
  probeAudioTracks: vi.fn(),
  listDisplayLuts: vi.fn(),
  setDisplayLut: vi.fn(),
  clearDisplayLut: vi.fn(),
  setPlaybackTrack: vi.fn(),
  setTranscribeTrack: vi.fn(),
  pickLutFile: vi.fn(),
  importLut: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { TechCheckPanel } from "./TechCheckPanel";

function makeClip(overrides: Partial<ClipListItem> = {}): ClipListItem {
  return {
    id: 40,
    episode_id: 1,
    folder_label: null,
    cover_url: null,
    path: "/clips/a.mov",
    file_name: "a.mov",
    byte_size: 1024,
    quick_hash: "hash",
    full_hash: null,
    tb_num: 1,
    tb_den: 1000,
    duration_ticks: 2000,
    fps_num: 30000,
    fps_den: 1001,
    is_vfr: false,
    codec: "hevc",
    width: 3840,
    height: 2160,
    captured_at: null,
    rotation: 0,
    color_transfer: "bt709",
    hdr_flag: false,
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: null,
    star_rating: null,
    select_count: 0,
    iso_value: null,
    shutter_speed: null,
    aperture: null,
    display_lut_path: null,
    selected_transcribe_track: null,
    selected_monitor_track: null,
    ...overrides,
  };
}

const trackOne: ClipAudioTrack = {
  clip_id: 40,
  stream_index: 0,
  channels: 2,
  channel_layout: "stereo",
  sample_rate: 48000,
  role_guess: "onboard_mic",
};
const trackTwo: ClipAudioTrack = {
  clip_id: 40,
  stream_index: 1,
  channels: 1,
  channel_layout: "mono",
  sample_rate: 48000,
  role_guess: "wireless_mic",
};

describe("TechCheckPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.listAudioTracks.mockResolvedValue([trackOne, trackTwo]);
    apiMock.probeAudioTracks.mockResolvedValue([trackOne, trackTwo]);
    apiMock.listDisplayLuts.mockResolvedValue(["/luts/rec709.cube", "/luts/flat.cube"]);
    apiMock.setDisplayLut.mockResolvedValue(undefined);
    apiMock.clearDisplayLut.mockResolvedValue(undefined);
    apiMock.setPlaybackTrack.mockResolvedValue(undefined);
    apiMock.setTranscribeTrack.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders two rows for two audio tracks", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    const rows = container.querySelectorAll(".tech-check-track");
    expect(rows.length).toBe(2);
  });

  it("calls setTranscribeTrack with the clip id and stream index on click", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    const rows = Array.from(container.querySelectorAll(".tech-check-track"));
    const secondRow = rows[1];
    const button = Array.from(secondRow.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "设为转录轨",
    );
    await act(async () => button?.click());
    expect(apiMock.setTranscribeTrack).toHaveBeenCalledWith(40, 1);
  });

  it("shows 设备未提供 when ISO is missing", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip({ iso_value: null })} readOnly={false} />));
    expect(container.textContent).toContain("设备未提供");
  });

  it("R10 U-13: 方向读 clip.orientation(rotation=0 的竖拍手机片显示竖屏), 缺失时回落 rotation", async () => {
    await act(async () =>
      root.render(
        <TechCheckPanel clip={makeClip({ rotation: 0, width: 1080, height: 1920, orientation: "portrait" })} readOnly={false} />,
      ),
    );
    expect(container.textContent).toContain("竖屏 · 0°");
    await act(async () =>
      root.render(<TechCheckPanel clip={makeClip({ rotation: 0, width: 1080, height: 1080, orientation: "square" })} readOnly={false} />),
    );
    expect(container.textContent).toContain("方屏 · 0°");
    await act(async () =>
      root.render(<TechCheckPanel clip={makeClip({ rotation: 90, orientation: undefined })} readOnly={false} />),
    );
    expect(container.textContent).toContain("竖屏 · 90°");
  });

  it("shows the preview-only LUT hint", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    expect(container.textContent).toContain("仅用于预览，不影响导出");
  });

  it("calls setDisplayLut when a LUT is selected", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    const select = container.querySelector("select[aria-label='选择显示 LUT']") as HTMLSelectElement;
    await act(async () => {
      select.value = "/luts/rec709.cube";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(apiMock.setDisplayLut).toHaveBeenCalledWith("clip", 40, "/luts/rec709.cube");
  });

  it("disables mutating controls in read-only episodes", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={true} />));
    expect(container.textContent).toContain("历史集为只读档案");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const select = container.querySelector("select[aria-label='选择显示 LUT']") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("hides 探测音轨 button when tracks are present", async () => {
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    const buttons = Array.from(container.querySelectorAll("button"));
    const probeButton = buttons.find((btn) => btn.textContent?.includes("探测"));
    expect(probeButton).not.toBeDefined();
  });

  it("shows 探测音轨 button when no tracks and clicking calls probeAudioTracks", async () => {
    apiMock.listAudioTracks.mockResolvedValue([]);
    await act(async () => root.render(<TechCheckPanel clip={makeClip()} readOnly={false} />));
    const buttons = Array.from(container.querySelectorAll("button"));
    const probeButton = buttons.find((btn) => btn.textContent?.includes("探测"));
    expect(probeButton).toBeDefined();
    expect(probeButton?.textContent).toBe("探测音轨");
    await act(async () => probeButton?.click());
    expect(apiMock.probeAudioTracks).toHaveBeenCalledWith(40);
  });
});
