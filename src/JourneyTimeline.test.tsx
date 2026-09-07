// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JourneyEntry } from "./api";

const apiMock = vi.hoisted(() => ({
  getJourneyTimeline: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { JourneyTimeline } from "./JourneyTimeline";

function clipEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    kind: "clip",
    canonical_time: "2026-09-01T09:00:00.000Z",
    undated: false,
    clip_id: 1,
    file_name: "a.mov",
    cover_url: null,
    destination_id: null,
    title: null,
    place_name: null,
    ...overrides,
  };
}

function destinationEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    kind: "destination",
    canonical_time: "2026-09-01T09:00:00.000Z",
    undated: false,
    clip_id: null,
    file_name: null,
    cover_url: null,
    destination_id: 1,
    title: "抵达富良野",
    place_name: "富良野",
    ...overrides,
  };
}

describe("JourneyTimeline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("groups dated entries under a YYYY-MM-DD day header", async () => {
    apiMock.getJourneyTimeline.mockResolvedValue([clipEntry()]);
    await act(async () => {
      root.render(<JourneyTimeline />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("2026-09-01");
    expect(container.textContent).toContain("a.mov");
  });

  it("renders a destination card as a milestone row with place name and title", async () => {
    apiMock.getJourneyTimeline.mockResolvedValue([destinationEntry()]);
    await act(async () => {
      root.render(<JourneyTimeline />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".journey-milestone")).not.toBeNull();
    expect(container.textContent).toContain("富良野");
    expect(container.textContent).toContain("抵达富良野");
  });

  it("puts undated entries into a 「未标时间」 section, separate from dated days", async () => {
    apiMock.getJourneyTimeline.mockResolvedValue([
      clipEntry({ clip_id: 1, file_name: "dated.mov" }),
      clipEntry({
        clip_id: 2,
        file_name: "undated.mov",
        canonical_time: "",
        undated: true,
      }),
    ]);
    await act(async () => {
      root.render(<JourneyTimeline />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("未标时间");
    const sections = container.querySelectorAll(".journey-day");
    expect(sections.length).toBe(2);
    expect(sections[1].textContent).toContain("undated.mov");
    expect(sections[1].querySelector(".journey-day-header")?.textContent).toBe("未标时间");
  });

  it("renders nothing to act on: no buttons or inputs in this read-only view", async () => {
    apiMock.getJourneyTimeline.mockResolvedValue([clipEntry(), destinationEntry()]);
    await act(async () => {
      root.render(<JourneyTimeline />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll("button, input, textarea").length).toBe(0);
  });
});
