import { describe, expect, it } from "vitest";

import { USAGE_DESCRIPTION_KEYS, auditInfoPlist } from "./infoPlist.mjs";

/** 0.8.3 发布包的实读键值(`plutil -convert xml1 /Applications/旅剪工作台.app/Contents/Info.plist`)。 */
const SHIPPED_0_8_3 = {
  CFBundleDevelopmentRegion: "English",
  CFBundleDisplayName: "旅剪工作台",
  CFBundleExecutable: "tripcut-studio",
  CFBundleIdentifier: "com.tripcut.studio",
  CFBundleShortVersionString: "0.8.3",
  CSResourcesFileMapped: true,
  LSMinimumSystemVersion: "14.0",
  LSRequiresCarbon: true,
  NSHighResolutionCapable: true,
};

const AFTER_M07 = {
  ...SHIPPED_0_8_3,
  CFBundleDevelopmentRegion: "zh-Hans",
  CFBundleLocalizations: ["zh-Hans", "en"],
  LSRequiresCarbon: false,
  NSDesktopFolderUsageDescription: "旅剪要读桌面上的视频来导入素材;原片只读,不会被改动。",
  NSDocumentsFolderUsageDescription: "旅剪要读文稿文件夹里的视频来导入素材;原片只读,不会被改动。",
  NSDownloadsFolderUsageDescription: "旅剪要读下载文件夹里的视频来导入素材;原片只读,不会被改动。",
  NSRemovableVolumesUsageDescription: "旅剪要读相机卡或 U 盘上的视频来导入素材;原片只读,不会被改动。",
  NSNetworkVolumesUsageDescription: "旅剪要读网络磁盘上的视频来导入素材;原片只读,不会被改动。",
};

describe("Info.plist 审计", () => {
  it("对 0.8.3 实际发出去的那份报红(探针会红的证据)", () => {
    const findings = auditInfoPlist(SHIPPED_0_8_3);
    expect(findings.some((line) => line.includes("CFBundleDevelopmentRegion"))).toBe(true);
    expect(findings.some((line) => line.includes("CFBundleLocalizations"))).toBe(true);
    expect(findings.some((line) => line.includes("LSRequiresCarbon"))).toBe(true);
    for (const key of USAGE_DESCRIPTION_KEYS) {
      expect(findings).toContain(`缺 ${key}`);
    }
  });

  it("补齐之后放行", () => {
    expect(auditInfoPlist(AFTER_M07)).toEqual([]);
  });

  it("用途说明不是中文也算没做——系统弹框里用户看到的就是这句话", () => {
    const englishCopy = { ...AFTER_M07, NSDesktopFolderUsageDescription: "TripCut needs access." };
    expect(auditInfoPlist(englishCopy)).toEqual(["NSDesktopFolderUsageDescription 不是中文:TripCut needs access."]);
  });
});
