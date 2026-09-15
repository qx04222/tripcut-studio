/**
 * R18 车道 native / M-01:菜单栏审计的**判定部分**(纯函数,吃 `axmenu.swift` 的 JSON)。
 *
 * 判定与取数分开的理由写在业主记忆里(「UI探针本身是检测器」「唤醒后巡检全站P0是探针故障」):
 * 抓不到菜单栏 / 没有辅助功能权限 / 菜单少于六条,这些都是**探针故障**,
 * 要报 `PROBE` 而不是报缺陷——否则每次权限没给都会被读成"菜单栏没了"。
 */

/** 至少有一个 CJK 码点。按码点判,不按空格分词——中文没有空格。 */
export function hasChinese(text) {
  return [...String(text ?? "")].some((character) => {
    const code = character.codePointAt(0);
    return code >= 0x4e00 && code <= 0x9fff;
  });
}

function flatten(items) {
  const flat = [];
  for (const item of items ?? []) {
    flat.push(item);
    if (Array.isArray(item.items)) flat.push(...flatten(item.items));
  }
  return flat;
}

/** 默认菜单里那些英文标题——出现任何一条就说明我们的菜单没挂上,系统默认菜单还在。 */
const SYSTEM_DEFAULT_TITLES = ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All", "Services"];

/**
 * @param {{ok?: boolean, error?: string, menus?: Array<{title: string, items: Array<object>}>}} dump
 * @returns {{status: "PASS"|"FAIL"|"PROBE", findings: string[]}}
 */
export function auditMenuBar(dump) {
  if (!dump || dump.ok !== true) {
    return { status: "PROBE", findings: [dump?.error ?? "axmenu 没有输出可用的 JSON"] };
  }
  const menus = Array.isArray(dump.menus) ? dump.menus : [];
  // 正控:一个跑起来的 macOS 应用**一定**有菜单栏,而且至少有应用菜单 + 几条。
  // 少于六条先怀疑自己抓错了进程,而不是宣布缺陷。
  if (menus.length < 6) {
    return { status: "PROBE", findings: [`只抓到 ${menus.length} 条顶级菜单,先确认 pid 抓对了`] };
  }
  const findings = [];
  for (const menu of menus) {
    // 第一条是系统的  菜单,AX 报名「Apple」,不归应用管。
    if (menu.title === "Apple") continue;
    if (!hasChinese(menu.title)) findings.push(`顶级菜单标题不是中文:「${menu.title}」`);
  }
  const all = menus.flatMap((menu) => flatten(menu.items));
  for (const banned of SYSTEM_DEFAULT_TITLES) {
    if (all.some((item) => item.title === banned)) {
      findings.push(`菜单里还留着系统默认的英文项「${banned}」——我们的菜单没挂上,或者少写了一条中文标题`);
    }
  }
  // macOS 13 起系统叫「设置…」,更早叫「偏好设置…」;两种都算对。
  const settings = all.find((item) => item.title === "设置…" || item.title === "偏好设置…");
  if (!settings) findings.push("应用菜单里没有「设置…」");
  else if (settings.cmd !== ",") findings.push(`「${settings.title}」的快捷键是 ${settings.cmd ?? "(没有)"},不是 ⌘,`);
  const undo = all.find((item) => item.title === "撤销");
  if (!undo) findings.push("编辑菜单里没有自定义的「撤销」——⌘Z 还会被系统菜单吃掉");
  else if (String(undo.cmd ?? "").toLowerCase() !== "z") findings.push("「撤销」没有挂在 ⌘Z 上");
  const help = menus.find((menu) => menu.title === "帮助");
  if (!help) findings.push("没有「帮助」菜单");
  else if ((help.items ?? []).length < 2) findings.push("「帮助」菜单少于两条");
  return { status: findings.length === 0 ? "PASS" : "FAIL", findings };
}
