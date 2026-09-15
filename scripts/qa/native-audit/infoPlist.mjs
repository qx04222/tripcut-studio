/**
 * R18 车道 native / M-07① + H-07 + H-23:打包后的 Info.plist 该有什么。
 *
 * 判定是纯函数,吃一份 `key → 值` 的对象(`audit-dmg.mjs` 用 plutil 抓,vitest 里喂固定样本)。
 * 三件事:
 *  - **本地化元数据**:`CFBundleDevelopmentRegion=zh-Hans` + `CFBundleLocalizations`。
 *    实测 0.8.3 的包写着 `English`——于是 NSOpenPanel / 系统弹框在一个通体中文的应用里说英文。
 *  - **五条文件夹用途说明**:桌面 / 文稿 / 下载 / 可移动卷 / 网络卷。用户的素材就放在这几处,
 *    缺了 TCC 弹框只会说系统默认那句话,说不出"旅剪要读它来导入素材"。
 *  - `LSRequiresCarbon`:Tauri 模板遗留,2026 年的应用不该声明它。
 */

/** 五条 `NS*UsageDescription`——键名 + 这句话至少要提到的词。 */
export const USAGE_DESCRIPTION_KEYS = [
  "NSDesktopFolderUsageDescription",
  "NSDocumentsFolderUsageDescription",
  "NSDownloadsFolderUsageDescription",
  "NSRemovableVolumesUsageDescription",
  "NSNetworkVolumesUsageDescription",
];

function hasChinese(text) {
  return [...String(text ?? "")].some((character) => {
    const code = character.codePointAt(0);
    return code >= 0x4e00 && code <= 0x9fff;
  });
}

/**
 * @param {Record<string, unknown>} values 打包后 Info.plist 的键值(缺的键就别放进来)
 * @returns {string[]} 空数组 = 通过
 */
export function auditInfoPlist(values) {
  const findings = [];
  const region = values.CFBundleDevelopmentRegion;
  if (region !== "zh-Hans") {
    findings.push(`CFBundleDevelopmentRegion=${region ?? "(缺)"},应为 zh-Hans`);
  }
  const localizations = values.CFBundleLocalizations;
  if (!Array.isArray(localizations) || !localizations.includes("zh-Hans")) {
    findings.push("CFBundleLocalizations 缺 zh-Hans");
  }
  for (const key of USAGE_DESCRIPTION_KEYS) {
    const text = values[key];
    if (typeof text !== "string" || text.trim() === "") findings.push(`缺 ${key}`);
    else if (!hasChinese(text)) findings.push(`${key} 不是中文:${text}`);
  }
  // 值被合并成 false 也算达标;真正要防的是"这个包还在声称自己需要 Carbon"。
  if (values.LSRequiresCarbon === true) findings.push("LSRequiresCarbon 还是 true(Tauri 模板遗留)");
  return findings;
}
