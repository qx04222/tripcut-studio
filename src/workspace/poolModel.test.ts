import { describe, expect, it } from "vitest";

import { fileNameLines } from "./poolModel";

describe("fileNameLines", () => {
  it("在最接近中点的 _ 处断行,不做中段省略", () => {
    expect(fileNameLines("20260812_昆明长水机场_出发_01.MP4")).toEqual(["20260812_昆明长水机场_", "出发_01.MP4"]);
  });
  it("扩展名与序号永远在第二行末尾(迁自 splitFileName 的 tail 语义)", () => {
    const [, tail] = fileNameLines("DJI_20260812_083411_0003_D.MP4");
    expect(tail!.endsWith("_D.MP4")).toBe(true);
  });
  it("没有下划线就按中点断", () => {
    expect(fileNameLines("ABCDEFGHIJKLMNOPQRSTUVWX.MOV", 12)).toEqual(["ABCDEFGHIJKL", "MNOPQRSTUVWX.MOV"]);
  });
  it("短名只有一行", () => {
    expect(fileNameLines("C0047.MP4")).toEqual(["C0047.MP4", null]);
  });
  it("两行合起来就是原名,一个字符不丢", () => {
    for (const name of ["20260812_昆明长水机场_出发_01.MP4", "DJI_20260812_083411_0003_D.MP4", "C0047.MP4"]) {
      const [head, tail] = fileNameLines(name);
      expect(head + (tail ?? "")).toBe(name);
    }
  });
});
