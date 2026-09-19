// @vitest-environment jsdom
// R19 P-09(results 车道):首页「让软件先挑一版」三张预设句卡 —— 点了回工作区并广播那句;库空禁用;零术语。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  listEpisodes: vi.fn(async () => [] as EpisodeSummary[]),
  createEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
}));
vi.mock("../api", () => apiMocks);
const feedMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedMock.state }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

const ACTIVE: EpisodeSummary = {
  id: 1,
  title: "EP01 大理",
  theme: "",
  episode_number: 1,
  status: "active",
  created_at: "2026-08-11T20:00:00+08:00",
  archived_at: null,
  clip_count: 0,
  favorite_count: 0,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};

import { HomeScreen } from "./HomeScreen";
import { FIRST_ROUND_VOCABULARY } from "./homeModel";
import { __resetHomeForTests, isHomePinned, pinHome } from "./homeStore";
import { __resetModalStackForTests } from "./modalStack";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { SELECT_PRESETS, SELECT_PROMPT_EVENT } from "./selectPrompt";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

function feed(patch: Record<string, unknown> = {}) {
  return { clips: [], loading: false, episode: { activeId: 1, viewing: null, scopeId: 1, current: ACTIVE }, ...patch };
}

beforeEach(() => {
  __resetHomeForTests();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  pipelineMock.state = derivePipeline(base);
  feedMock.state = feed();
  apiMocks.listEpisodes.mockReset().mockResolvedValue([ACTIVE]);
});
afterEach(cleanup);

describe("R19 P-09 首页预设句卡", () => {
  it("有素材时三张卡可点:点「电影感」→ 首页让位 + 广播 tripcut:select-prompt 带那句;AX 名 = 标签:句子", () => {
    feedMock.state = feed({ clips: [{ id: 1 }], episode: { activeId: 1, viewing: null, scopeId: 1, current: { ...ACTIVE, clip_count: 1 } } });
    pinHome(true);
    const heard = vi.fn<(event: Event) => void>();
    window.addEventListener(SELECT_PROMPT_EVENT, heard);
    render(<HomeScreen />);
    const group = screen.getByRole("group", { name: "让软件先挑一版" });
    const cards = within(group).getAllByRole("button");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(SELECT_PRESETS.map((preset) => `${preset.label}:${preset.sentence}`));
    expect(cards.every((card) => !(card as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: /^电影感:/ }));
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as CustomEvent<{ sentence: string }>).detail.sentence).toBe(SELECT_PRESETS[1]!.sentence);
    expect(isHomePinned()).toBe(false);
    window.removeEventListener(SELECT_PROMPT_EVENT, heard);
  });

  it("库空时三张卡禁用(没素材可挑),点了不广播;首页 DOM 仍不含首轮词表", () => {
    const heard = vi.fn();
    window.addEventListener(SELECT_PROMPT_EVENT, heard);
    const { container } = render(<HomeScreen />);
    const group = screen.getByRole("group", { name: "让软件先挑一版" });
    const cards = within(group).getAllByRole("button");
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => (card as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(cards[0]!);
    expect(heard).not.toHaveBeenCalled();
    for (const word of FIRST_ROUND_VOCABULARY) expect(container.textContent ?? "").not.toContain(word);
    window.removeEventListener(SELECT_PROMPT_EVENT, heard);
  });
});
