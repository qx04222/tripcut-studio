// macOS 可访问性(AX)驱动原语。取自 scripts/qa/smoke-gui.mjs——那些 AX 路径和超时值
// 都是对着活树走查出来的,不是文档抄来的。
//
// 已知债务:smoke-gui.mjs 目前仍保留它自己的那一份实现,没有改成 import 本模块。
// 不是忘了——是本轮无法重跑冒烟门禁(它要 perf 夹具库才有 clips 可评级),
// 改一个跑不了的门禁等于把"没验证过的重构"混进 R6。同一组常量现在有两份,
// 界面结构一变会各自腐烂;下一轮能跑冒烟时应当合并。
//
// 三条来自 smoke-gui 的硬经验,搬过来时一并保留:
//  1. 对已死进程发 System Events 的 AppleEvent 不会快速报错,会挂到 Apple Event Manager
//     自己的超时(实测 >2 分钟)。所以每次 osascript 都带 10s 超时。
//  2. System Events 认的是可执行文件进程名(tripcut-studio),不是 `tell application`
//     用的 LaunchServices 显示名(旅剪工作台 QA)。更新装完后显示名还会变回
//     「旅剪工作台」,所以本模块一律不用显示名,只用进程名和 pid。
//  3. keystroke 按当前(拉丁)键盘布局逐键发送,中文字符会变成乱码。要点中文控件只能走
//     可访问性点击,不能靠 ⌘K + 键入中文。
import { spawnSync } from "node:child_process";

export const UI_PROCESS = "tripcut-studio";

export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 默认 10s;逐元素遍历型脚本必须显式加大(见 clickByLabel 的注释:实测走完整棵
// 1200 个元素的 AX 树、每个元素取一次 name,要 ~27s。超时被杀掉时 spawnSync 返回
// 空 stdout,和"没找到"长得一模一样——这正是第一次跑 e2e 时按钮"点不中"的原因之一)。
export const osa = (script, timeoutMs = 10000) =>
  spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: timeoutMs });

export const alivePids = (executablePath) => {
  const result = spawnSync("pgrep", ["-f", executablePath], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
};

export const entireContents = (uiProcess = UI_PROCESS) =>
  osa(`tell application "System Events" to tell process "${uiProcess}" to get entire contents of window 1`).stdout ?? "";

export const containsText = (needle, uiProcess = UI_PROCESS) => entireContents(uiProcess).includes(needle);

// 界面文字断言用 `entire contents`。它是一次性批量取回的对象说明符文本(实测 0.4s、
// 260KB),里面带着每个元素的名字,页面上的中文正文——按钮名、状态行、版本号——都在。
//
// 曾经写过一版 windowText,逐元素取 name/value/description 拼字符串。它在活树上要 54s,
// 撞上 osa 的 10s 超时被杀,返回空串;而"空串"被断言读成"页面上没有这段文字"。
// 判据装置自己静默失败,看起来和被测对象没渲染完全一样——所以这里换成一次批量读。
export const windowText = (uiProcess = UI_PROCESS) => entireContents(uiProcess);

// 等 UI 出现某段文字。返回命中的那一项(或 null)。轮询而不是定长 sleep:
// 下载耗时取决于包多大和本地 http 服务多快,写死时长要么白等要么早退。
export const waitForText = (needles, { timeoutMs = 60000, intervalMs = 1000, uiProcess = UI_PROCESS } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  do {
    lastText = windowText(uiProcess);
    for (const needle of needles) {
      if (lastText.includes(needle)) return { needle, text: lastText };
    }
    sleep(intervalMs);
  } while (Date.now() < deadline);
  return { needle: null, text: lastText };
};

export const activatePid = (pid) =>
  osa(`tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`);

// 按可访问名称"包含"匹配后 AXPress。比写死 group 路径慢,但不依赖精确嵌套,
// 结构一变不会变成静默的空点击(错路径点不到任何东西却也不报错)。
export const clickByLabel = (label, { attempts = 4, exact = false, uiProcess = UI_PROCESS } = {}) => {
  const escaped = label.replaceAll('"', '\\"');
  // exact:界面上「检查更新」既是按钮名,也出现在状态行「尚未检查更新。」里。包含匹配会
  // 先撞上谁取决于 AX 树顺序——那是运气,不是判据。要点按钮就按名字全等找。
  const condition = exact ? `(name of elem) is "${escaped}"` : `(name of elem) contains "${escaped}"`;
  // 必须先把 entire contents 绑到变量再遍历。内联写法(repeat with elem in
  // (entire contents of window 1))照样跑完 1200 个元素,但每个 elem 的 name 都读不出来
  // ——实测同一棵树:绑变量版数到 643 个有名字的元素,内联版数到 0,于是永远返回
  // notfound。那是一个只会静默失败的点击器(smoke-gui 里这两条断言长期是 WARN,
  // 原因就在这)。
  const script = `tell application "System Events" to tell process "${uiProcess}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if ${condition} then
        perform action "AXPress" of elem
        return "clicked"
      end if
    end try
  end repeat
  return "notfound"
end tell`;
  // 120s:这段脚本是逐元素遍历,命中位置越靠后越慢(设置页的「检查更新」在第 338 个
  // 元素上,实测约 8s;整棵树走完约 27s)。10s 的默认超时会在还没走到目标时就把
  // osascript 杀掉,表现为"控件不存在"。
  for (let i = 0; i < attempts; i += 1) {
    const result = osa(script, 120000);
    if (result.status === 0 && result.stdout.trim() === "clicked") return true;
    sleep(300);
  }
  return false;
};

export const NAV_GROUP = `group "工作流导航" of group 1 of UI element 1 of scroll area 1 of group 1 of group 1`;

export const clickNav = (axName, { attempts = 6, uiProcess = UI_PROCESS } = {}) => {
  const script = `tell application "System Events" to tell process "${uiProcess}" to click UI element "${axName}" of ${NAV_GROUP} of window 1`;
  for (let i = 0; i < attempts; i += 1) {
    if (osa(script).status === 0) return true;
    sleep(400);
  }
  return false;
};

// 首启两层浮层:FirstRunGuide(组件自检)与 SetupWizard(欢迎向导)。不点掉的话
// 之后每一次点击都打在浮层上,页面看起来"没反应"。
export const OVERLAY_BUTTONS = [
  ["暂时进入工作台", `group 3 of group "先把本地工具链接好" of UI element 1 of scroll area 1 of group 1 of group 1`, "first-run-guide"],
  ["开始使用", `group 4 of group "安装向导" of UI element 1 of scroll area 1 of group 1 of group 1`, "setup-wizard"],
];

export const dismissOverlay = (buttonName, groupPath, { attempts = 8, uiProcess = UI_PROCESS } = {}) => {
  const script = `tell application "System Events" to tell process "${uiProcess}" to click button "${buttonName}" of ${groupPath} of window 1`;
  for (let i = 0; i < attempts; i += 1) {
    if (osa(script).status === 0) return true;
    sleep(500);
  }
  return false;
};

export const dismissOnboarding = (options = {}) => {
  const dismissed = {};
  for (const [button, path, label] of OVERLAY_BUTTONS) {
    dismissed[label] = dismissOverlay(button, path, options);
    sleep(800);
  }
  return dismissed;
};

// 原生 NSAlert 会阻塞主线程,窗口渲染停住,探针会把它读成"页面卡死"。
// 单写锁没及时释放时(比如更新后新进程抢在旧进程退出之前起来)就会弹这个。
export const nativeDialogText = (uiProcess = UI_PROCESS) => {
  const result = osa(
    `tell application "System Events" to tell process "${uiProcess}" to get value of every static text of window 1 whose subrole is "AXStandardWindow"`,
  );
  const sheet = osa(`tell application "System Events" to tell process "${uiProcess}" to get name of every window`);
  return `${result.stdout ?? ""} ${sheet.stdout ?? ""}`.trim();
};

export const dismissNativeDialog = (uiProcess = UI_PROCESS) =>
  osa(`tell application "System Events" to tell process "${uiProcess}"
  repeat with w in windows
    try
      click button 1 of w
      return "clicked"
    end try
  end repeat
  return "notfound"
end tell`).stdout?.trim() === "clicked";
