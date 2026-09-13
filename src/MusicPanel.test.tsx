// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MusicAnalysis, MusicTrackSummary } from "./api";

const apiMock = vi.hoisted(() => ({
  getCurrentEpisode: vi.fn(),
  pickMusicFile: vi.fn(),
  importMusicTrack: vi.fn(),
  listMusicTracks: vi.fn(),
  getMusicAnalysis: vi.fn(),
  deleteMusicTrack: vi.fn(),
  MUSIC_ANALYZED_EVENT: "tripcut:music-analyzed",
}));
vi.mock("./api", () => apiMock);

import { MusicPanel } from "./MusicPanel";

const episode = {
  id: 7,
  title: "第一集",
  theme: "",
  episode_number: 1,
  status: "active" as const,
  created_at: "",
  archived_at: null,
  clip_count: 0,
  favorite_count: 0,
  export_count: 0,
  target_platform: "general" as const,
  canvas_orientation: "landscape" as const,
};

function track(overrides: Partial<MusicTrackSummary> = {}): MusicTrackSummary {
  return {
    id: 1,
    episode_id: 7,
    file_name: "road-trip.mp3",
    rel_path: "music/road-trip.mp3",
    quick_hash: null,
    created_at: "",
    duration_ticks: 10_000,
    tb_num: 1,
    tb_den: 1_000,
    bpm: 120,
    analysis_status: "done",
    blocked_summary: null,
    ...overrides,
  };
}

function analysisOf(t: MusicTrackSummary): MusicAnalysis {
  return {
    track: t,
    beats: [
      { tick: 100, is_downbeat: true, strength: 0.9 },
      { tick: 600, is_downbeat: false, strength: 0.4 },
    ],
    sections: [
      { start_tick: 0, end_tick: 3_000, label: "intro", energy: 0.2 },
      { start_tick: 3_000, end_tick: 7_000, label: "build", energy: 0.6 },
      { start_tick: 7_000, end_tick: 10_000, label: "climax", energy: 0.9 },
    ],
    suggested_cut_ticks: [3_000, 7_000],
  };
}

describe("MusicPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.getCurrentEpisode.mockResolvedValue(episode);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("renders the track list for the current episode", async () => {
    apiMock.listMusicTracks.mockResolvedValue([track()]);
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.listMusicTracks).toHaveBeenCalledWith(7);
    expect(container.textContent).toContain("road-trip.mp3");
    expect(container.textContent).toContain("120 BPM");
  });

  it("import flow calls pickMusicFile then importMusicTrack and refreshes the list", async () => {
    apiMock.listMusicTracks.mockResolvedValueOnce([]).mockResolvedValueOnce([track()]);
    apiMock.pickMusicFile.mockResolvedValue("/music/road-trip.mp3");
    apiMock.importMusicTrack.mockResolvedValue(track());
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("导入音乐"),
    );
    await act(async () => {
      importButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.pickMusicFile).toHaveBeenCalled();
    expect(apiMock.importMusicTrack).toHaveBeenCalledWith("/music/road-trip.mp3");
    expect(apiMock.listMusicTracks).toHaveBeenCalledTimes(2);
  });

  it("renders section bands and BPM text when a track is selected", async () => {
    const t = track();
    apiMock.listMusicTracks.mockResolvedValue([t]);
    apiMock.getMusicAnalysis.mockResolvedValue(analysisOf(t));
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const selectButton = container.querySelector(".music-track-select") as HTMLButtonElement;
    await act(async () => {
      selectButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll(".music-section-band").length).toBe(3);
    expect(container.textContent).toContain("120 BPM");
  });

  it("shows the copied-cut notice when a cut marker is clicked, without touching any segment API", async () => {
    const t = track();
    apiMock.listMusicTracks.mockResolvedValue([t]);
    apiMock.getMusicAnalysis.mockResolvedValue(analysisOf(t));
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const selectButton = container.querySelector(".music-track-select") as HTMLButtonElement;
    await act(async () => {
      selectButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const marker = container.querySelector(".music-cut-marker") as unknown as SVGLineElement;
    await act(async () => {
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("已复制切点");
  });

  it("R10 U-19: 收到 tripcut:music-analyzed 后重取列表,标签从「分析排队中…」翻成 BPM;选中的曲目也重取分析", async () => {
    const pendingTrack = track({ bpm: null, analysis_status: "pending" });
    apiMock.listMusicTracks.mockResolvedValueOnce([pendingTrack]).mockResolvedValue([track()]);
    apiMock.getMusicAnalysis.mockResolvedValue(analysisOf(pendingTrack));
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("分析排队中…");
    const selectButton = container.querySelector(".music-track-select") as HTMLButtonElement;
    await act(async () => {
      selectButton.click();
      await Promise.resolve();
    });
    expect(apiMock.getMusicAnalysis).toHaveBeenCalledTimes(1);
    apiMock.getMusicAnalysis.mockResolvedValue(analysisOf(track()));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("tripcut:music-analyzed", {
          detail: { track_id: 1, episode_id: 7, analysis_status: "done", bpm: 120 },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.listMusicTracks).toHaveBeenCalledTimes(2);
    expect(apiMock.getMusicAnalysis).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("120 BPM");
    expect(container.textContent).not.toContain("分析排队中…");
  });

  it("disables import and delete for a read-only episode", async () => {
    apiMock.listMusicTracks.mockResolvedValue([track()]);
    await act(async () => {
      root.render(<MusicPanel readOnly={true} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("历史集为只读档案");
    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("导入音乐"),
    );
    expect(importButton?.disabled).toBe(true);
    expect(container.querySelector(".music-track-delete")).toBeNull();
  });

  it("polls getMusicAnalysis every 3s while pending/running and stops on unmount", async () => {
    vi.useFakeTimers();
    const pendingTrack = track({ bpm: null, analysis_status: "pending" });
    apiMock.listMusicTracks.mockResolvedValue([pendingTrack]);
    apiMock.getMusicAnalysis.mockResolvedValue(analysisOf(pendingTrack));
    await act(async () => {
      root.render(<MusicPanel readOnly={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const selectButton = container.querySelector(".music-track-select") as HTMLButtonElement;
    await act(async () => {
      selectButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.getMusicAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.getMusicAnalysis).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    apiMock.getMusicAnalysis.mockClear();
    vi.advanceTimersByTime(9_000);
    expect(apiMock.getMusicAnalysis).not.toHaveBeenCalled();
  });
});
