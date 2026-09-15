/**
 * R18 车道 native2 / M-06① + M-12:打包后的 Info.plist 有没有把文件关联声明上。
 *
 * 判定是纯函数,吃打包后 `CFBundleDocumentTypes` 那一段(`plutil -convert json` 抓)。
 * 这一条决定的是**用户做得到什么**:双击 mp4 能不能选旅剪、Finder 的「打开方式」里
 * 有没有它、把一个文件夹拖到程序坞图标上会不会被接住。声明缺了,这三件事全都没有,
 * 而应用本身照样能跑——所以门禁里看不见,只有这条判定能看见。
 */

/** 必须被声明的扩展名。与 `src-tauri/src/opened.rs` 的 `IMPORTABLE_EXTENSIONS` 是同一份。 */
export const REQUIRED_EXTENSIONS = ["mp4", "mov", "m4v"];
/** 整个文件夹拖到程序坞图标上要被接住,靠的是这条 UTI。 */
export const REQUIRED_CONTENT_TYPE = "public.folder";

/**
 * @param {unknown} documentTypes 打包后 Info.plist 的 CFBundleDocumentTypes
 * @returns {string[]} 空数组 = 通过
 */
export function auditFileAssociations(documentTypes) {
  if (!Array.isArray(documentTypes) || documentTypes.length === 0) {
    return ["CFBundleDocumentTypes 缺失或为空——双击视频、「打开方式」、拖到程序坞图标全都不会落到旅剪身上"];
  }
  const findings = [];
  const extensions = new Set(
    documentTypes
      .flatMap((entry) => (Array.isArray(entry?.CFBundleTypeExtensions) ? entry.CFBundleTypeExtensions : []))
      .map((value) => String(value).replace(/^\./, "").toLowerCase()),
  );
  for (const extension of REQUIRED_EXTENSIONS) {
    if (!extensions.has(extension)) findings.push(`CFBundleTypeExtensions 缺 ${extension}`);
  }
  const contentTypes = new Set(
    documentTypes
      .flatMap((entry) => (Array.isArray(entry?.LSItemContentTypes) ? entry.LSItemContentTypes : []))
      .map(String),
  );
  if (!contentTypes.has(REQUIRED_CONTENT_TYPE)) {
    findings.push(`LSItemContentTypes 缺 ${REQUIRED_CONTENT_TYPE}——整个文件夹拖到程序坞图标上不会被接住`);
  }
  return findings;
}

/**
 * 窗口有没有落在某块屏上(M-02 的真机那一半)。
 * 判定吃 `axwindow.swift` 的 JSON;抓不到 / 没辅助功能权限一律报 PROBE 而不是缺陷
 * ——否则每次权限没给都会被读成"窗口跑到屏外去了"。
 *
 * @param {{ok?: boolean, error?: string, window?: {x:number,y:number,width:number,height:number}, screens?: Array<{x:number,y:number,width:number,height:number}>}} dump
 * @returns {{status: "PASS"|"FAIL"|"PROBE", findings: string[]}}
 */
export function auditWindowOnScreen(dump) {
  if (!dump || dump.ok !== true || !dump.window) {
    return { status: "PROBE", findings: [dump?.error ?? "axwindow 没有输出可用的 JSON"] };
  }
  const screens = Array.isArray(dump.screens) ? dump.screens : [];
  if (screens.length === 0) {
    return { status: "PROBE", findings: ["一块屏都没读到——先怀疑探针,不是窗口"] };
  }
  const window = dump.window;
  const area = Math.max(window.width * window.height, 1);
  const visible = screens.reduce((best, screen) => {
    const width = Math.max(0, Math.min(window.x + window.width, screen.x + screen.width) - Math.max(window.x, screen.x));
    const height = Math.max(0, Math.min(window.y + window.height, screen.y + screen.height) - Math.max(window.y, screen.y));
    return Math.max(best, width * height);
  }, 0);
  const ratio = visible / area;
  if (ratio < 0.25) {
    return {
      status: "FAIL",
      findings: [
        `窗口只有 ${(ratio * 100).toFixed(1)}% 落在屏幕上(${window.x},${window.y} ${window.width}×${window.height})——进程活着但用户什么都看不见`,
      ],
    };
  }
  return { status: "PASS", findings: [] };
}
