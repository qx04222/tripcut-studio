import { describe, expect, it } from "vitest";
import type { JianyingAvailability } from "../../api";
import { DELIVER_CARDS, cardToExportMode, resolveHandoffMode } from "./deliverCards";

const supported: JianyingAvailability = { installed_version: "11.3.0", supported: true, reason: "" };
const unsupported: JianyingAvailability = { installed_version: "11.4.13189", supported: false, reason: "" };

describe("deliverCards 纯函数(U-06/P-04 三卡)", () => {
  it("三张卡固定顺序:交给剪映 / 导出视频文件 / 整包交付", () => {
    expect(DELIVER_CARDS).toEqual(["handoff", "quick", "full"]);
  });

  it("resolveHandoffMode:可用 → jianying;不可用/未知 → kit(永远走得通的兜底)", () => {
    expect(resolveHandoffMode(supported)).toBe("jianying");
    expect(resolveHandoffMode(unsupported)).toBe("kit");
    expect(resolveHandoffMode(null)).toBe("kit");
  });

  it("cardToExportMode:handoff 卡按可用性分叉,quick/full 直通", () => {
    expect(cardToExportMode("handoff", supported)).toBe("jianying");
    expect(cardToExportMode("handoff", unsupported)).toBe("kit");
    expect(cardToExportMode("quick", supported)).toBe("quick");
    expect(cardToExportMode("full", unsupported)).toBe("full");
  });
});
