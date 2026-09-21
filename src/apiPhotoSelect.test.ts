import { describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { autoSelectEpisodeWith } from "./api";
import { parseSelectPrompt, toAutoSelectParams } from "./workspace/selectPrompt";

describe("photo selection command parameters", () => {
  it.each([["挑 20 张照片", true, 20], ["只要视频", false, null], ["挑 30 秒", null, null]])(
    "%s reaches the Rust command", async (sentence, onlyPhotos, photoCount) => {
      await autoSelectEpisodeWith(toAutoSelectParams(parseSelectPrompt(sentence), sentence, "all"));
      expect(invoke).toHaveBeenLastCalledWith("auto_select_episode_with", expect.objectContaining({ onlyPhotos, photoCount }));
    },
  );
});
