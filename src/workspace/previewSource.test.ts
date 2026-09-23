import { describe, expect, it } from "vitest";
import type { PlayerStatus } from "../api";
import { createDropMonitor, qualityLabel, sourceBadgeLabel } from "./previewSource";

describe("R25 来源与掉帧纯逻辑", () => {
  it("来源文字使用短边，旧后端无来源时隐藏", () => {
    expect(sourceBadgeLabel(null)).toBeNull();
    expect(sourceBadgeLabel({} as PlayerStatus)).toBeNull();
    for (const [kind, width, height, label] of [
      ["proxy", 960, 540, "代理 540p"], ["proxy_hq", 1080, 1920, "代理 1080p"],
      ["original", 3840, 2160, "原片 2160p"], ["original", null, null, "原片"], ["proxy", null, null, "代理"],
    ]) {
      expect(sourceBadgeLabel({ source_kind: kind, source_width: width, source_height: height } as PlayerStatus)).toBe(label);
    }
    expect(["auto", "high", "original", "performance"].map(qualityLabel)).toEqual(["自动", "高画质", "原片", "性能优先"]);
  });
  it("严格大于 5%，且至少十帧；暂停、换源、帧号回退都重置", () => {
    const m = createDropMonitor(() => 0);
    const feed = (f: number, d: number, p = false, k = "original") => m.feed(f, d, p, k).struggling;
    expect(feed(0, 0)).toBe(false);
    expect(feed(100, 9)).toBe(false);
    expect(feed(200, 10)).toBe(false);
    expect(feed(201, 11)).toBe(true);
    expect(feed(202, 12, true)).toBe(false);
    expect(feed(203, 12)).toBe(false);
    expect(feed(303, 22)).toBe(true);
    expect(feed(304, 22, false, "proxy_hq")).toBe(false);
    expect(feed(404, 32, false, "proxy_hq")).toBe(true);
    expect(feed(0, 0, false, "proxy_hq")).toBe(false);
    expect(feed(100, 30, false, "proxy")).toBe(false);
  });
  it("恰好十帧可触发，超过三秒的掉帧不再贡献", () => {
    let now = 0;
    const m = createDropMonitor(() => now);
    m.feed(0, 0, false, "original");
    now = 3000;
    expect(m.feed(100, 10, false, "original").struggling).toBe(true);
    now = 3001;
    expect(m.feed(101, 10, false, "original").struggling).toBe(false);
    expect(m.feed(null, 10, false, "original").struggling).toBe(false);
  });
});
