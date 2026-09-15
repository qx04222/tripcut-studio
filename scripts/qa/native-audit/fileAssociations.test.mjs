import { describe, expect, it } from "vitest";

import { auditFileAssociations, auditWindowOnScreen } from "./fileAssociations.mjs";

/** 0.8.3 的真包形态:`plutil -convert json` 抓出来根本没有 CFBundleDocumentTypes。 */
const OLD_BUNDLE_DOCUMENT_TYPES = undefined;

describe("auditFileAssociations(M-06① 的正控)", () => {
  it("旧包(没有文件关联)必须报红", () => {
    const findings = auditFileAssociations(OLD_BUNDLE_DOCUMENT_TYPES);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("CFBundleDocumentTypes");
  });

  it("只声明了视频、漏了文件夹也要报红——「拖文件夹到程序坞」是单独一条能力", () => {
    const findings = auditFileAssociations([
      { CFBundleTypeName: "视频", CFBundleTypeExtensions: ["mp4", "mov", "m4v"] },
    ]);
    expect(findings).toEqual([expect.stringContaining("public.folder")]);
  });

  it("少一个扩展名就点名少了哪个", () => {
    const findings = auditFileAssociations([
      { CFBundleTypeExtensions: [".MP4", "mov"], LSItemContentTypes: ["public.folder"] },
    ]);
    expect(findings).toEqual(["CFBundleTypeExtensions 缺 m4v"]);
  });

  it("本轮的声明形态通过", () => {
    expect(
      auditFileAssociations([
        { CFBundleTypeName: "视频", CFBundleTypeExtensions: ["mp4", "mov", "m4v"] },
        { CFBundleTypeName: "素材文件夹", LSItemContentTypes: ["public.folder"] },
      ]),
    ).toEqual([]);
  });
});

describe("auditWindowOnScreen(M-02 真机那一半)", () => {
  const screens = [{ x: 0, y: 0, width: 1512, height: 945 }];

  it("抓不到 / 没权限是 PROBE,不是缺陷", () => {
    expect(auditWindowOnScreen(null).status).toBe("PROBE");
    expect(auditWindowOnScreen({ ok: false, error: "没有辅助功能权限" }).status).toBe("PROBE");
    expect(auditWindowOnScreen({ ok: true, window: { x: 0, y: 0, width: 10, height: 10 }, screens: [] }).status).toBe("PROBE");
  });

  it("x=5000 那种屏外窗口必须报红", () => {
    const verdict = auditWindowOnScreen({ ok: true, window: { x: 5000, y: 20, width: 1280, height: 800 }, screens });
    expect(verdict.status).toBe("FAIL");
    expect(verdict.findings[0]).toContain("用户什么都看不见");
  });

  it("正常窗口通过;压边但露出四分之一以上也算通过", () => {
    expect(auditWindowOnScreen({ ok: true, window: { x: 100, y: 60, width: 1280, height: 800 }, screens }).status).toBe("PASS");
    expect(auditWindowOnScreen({ ok: true, window: { x: 1000, y: 60, width: 1280, height: 800 }, screens }).status).toBe("PASS");
  });
});
