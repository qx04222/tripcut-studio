import { describe, expect, it } from "vitest";

import {
  AUTO_CHECK_THROTTLE_MS,
  autoCheckVerdict,
  askBeforeDownload,
  describeUpdateFailure,
  downloadStatusLabel,
  isSkippedVersion,
  lastCheckLabel,
  notesToParagraphs,
} from "./updateModel";

const NOW = Date.parse("2026-09-14T12:00:00Z");

/** R17 车道 B:自动升级的判据层。 */
describe("autoCheckVerdict", () => {
  it("默认(没有任何键)就查;`updater.auto_update=false` 不查;离线静默", () => {
    expect(autoCheckVerdict({}, NOW, true)).toBe("check");
    expect(autoCheckVerdict({ "updater.auto_update": "false" }, NOW, true)).toBe("disabled");
    expect(autoCheckVerdict({}, NOW, false)).toBe("offline");
    // 旧键名 auto_check 不再被认(业主拍板改成 auto_update)。
    expect(autoCheckVerdict({ "updater.auto_check": "false" }, NOW, true)).toBe("check");
  });

  it("24 小时内查过就不再查;刚好过 24 小时再查;坏掉的时间戳当没查过", () => {
    const recent = new Date(NOW - AUTO_CHECK_THROTTLE_MS + 60_000).toISOString();
    expect(autoCheckVerdict({ "updater.last_check": recent }, NOW, true)).toBe("throttled");
    const stale = new Date(NOW - AUTO_CHECK_THROTTLE_MS).toISOString();
    expect(autoCheckVerdict({ "updater.last_check": stale }, NOW, true)).toBe("check");
    expect(autoCheckVerdict({ "updater.last_check": "garbage" }, NOW, true)).toBe("check");
  });

  it("「先问我再下载」默认关", () => {
    expect(askBeforeDownload({})).toBe(false);
    expect(askBeforeDownload({ "updater.ask_before_download": "true" })).toBe(true);
  });

  it("跳过的版本只认完全相同的版本号", () => {
    expect(isSkippedVersion({ "updater.skipped_version": "0.8.0" }, "0.8.0")).toBe(true);
    expect(isSkippedVersion({ "updater.skipped_version": "0.8.0" }, "0.8.1")).toBe(false);
    expect(isSkippedVersion({}, "0.8.0")).toBe(false);
    expect(isSkippedVersion({ "updater.skipped_version": "" }, "")).toBe(false);
  });
});

describe("downloadStatusLabel", () => {
  it("有总长按百分比向下取整;没总长念 MB;不超过 100%", () => {
    expect(downloadStatusLabel(42_900, 100_000)).toBe("正在下载更新 42%");
    expect(downloadStatusLabel(120_000, 100_000)).toBe("正在下载更新 100%");
    expect(downloadStatusLabel(12 * 1024 * 1024, null)).toBe("正在下载更新 12 MB");
    expect(downloadStatusLabel(0, 0)).toBe("正在下载更新 0 KB");
  });
});

describe("describeUpdateFailure", () => {
  it("签名错误 / 网络错误 / 磁盘错误各一句白话,原文留在 detail", () => {
    expect(describeUpdateFailure(new Error("The signature verification failed")).reason).toBe("更新包没通过安全校验,已拒绝安装");
    // 断网的错误串尾巴里带 X-Amz-Signature 的 URL,不能被判成签名错误。
    const network = describeUpdateFailure("error sending request for url (https://x.s3.amazonaws.com/a?X-Amz-Signature=abc)");
    expect(network.reason).toBe("网络连不上更新服务器");
    expect(network.detail).toContain("X-Amz-Signature");
    expect(describeUpdateFailure(new Error("No space left on device (os error 28)")).reason).toBe("磁盘空间不够或没有写入权限");
    expect(describeUpdateFailure({ weird: true }).reason).toBe("遇到了意外错误");
    expect(describeUpdateFailure("").detail).toBe("未知错误");
  });
});

describe("lastCheckLabel", () => {
  it("从未 / 刚刚 / 分钟 / 小时 / 昨天 / 日期", () => {
    expect(lastCheckLabel(null, NOW)).toBe("还没检查过");
    expect(lastCheckLabel(new Date(NOW - 10_000).toISOString(), NOW)).toBe("刚刚");
    expect(lastCheckLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 分钟前");
    expect(lastCheckLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 小时前");
    expect(lastCheckLabel(new Date(NOW - 30 * 3_600_000).toISOString(), NOW)).toBe("昨天");
    expect(lastCheckLabel("2026-09-01T12:00:00Z", NOW)).toMatch(/^2026-0[89]-\d\d$/);
  });
});

describe("notesToParagraphs", () => {
  it("标题、列表、粗体、链接、代码都变成纯文本段落;空行分段", () => {
    const md = "## 0.8.0\n\n- 自动**发现**新版本\n- 见 [说明](https://x)\n\n`快速导出` 修好了\r\n---\n第三段";
    expect(notesToParagraphs(md)).toEqual(["0.8.0", "• 自动发现新版本\n• 见 说明", "快速导出 修好了", "第三段"]);
    expect(notesToParagraphs("")).toEqual([]);
    expect(notesToParagraphs(null)).toEqual([]);
  });
});
