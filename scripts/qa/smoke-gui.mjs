#!/usr/bin/env node
// GUI 冒烟:对 CUA 候选实例点顶栏按钮、在单屏工作区里直接断言、截图、键盘评级,
// 判定用隔离库行数与进程存活。R8 起界面是单屏导演台(规格 §1),四步导航已下线。
// 用法: node scripts/qa/smoke-gui.mjs --candidate <prepare-cua-candidate 输出目录> [--fixtures <目录>] [--out <目录>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const candidateDir = resolve(argument("--candidate") ?? "");
const manifest = JSON.parse(readFileSync(join(candidateDir, "manifest.json"), "utf8"));
const supportDir = manifest.candidate.supportDirectory;
const appName = "旅剪工作台 QA";
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-smoke`));
mkdirSync(outDir, { recursive: true });
const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${detail}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
// 校准跑(先杀候选再跑脚本)证明过:对着已死进程的 System Events AppleEvent 不会快速
// 报错,会挂起到 Apple Event Manager 自己的超时(实测超过 2 分钟)。10s 超时把"进程已死"
// 从"脚本挂起几分钟"变成"这一步立刻失败",配合下面的提前退出使 FAIL 路径可预期地快。
const osa = (script) => sh("osascript", ["-e", script], { timeout: 10000 });
// 读整棵树 / 遍历整棵树找按钮的两类脚本不能用 10s:真机实测选中一条素材、监视器
// 开播之后,窗口 AX 树会从 ~15 KB 涨到 ~274 KB,遍历式点击从秒级退化到分钟级
// (r8-realcheck3 §5)。10s 会把"树大了"误判成"按钮不存在"。90s 仍然有界 ——
// 对着已死进程发 AppleEvent 时 osascript 自己会先失败,不会挂满 90s。
const osaSlow = (script) => sh("osascript", ["-e", script], { timeout: 90000 });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// -readonly avoids taking any lock against the live app's WAL-mode DB. A single
// invocation's result is retried (not re-queried per caller) because a prior bug had
// db.integrity call sqlite() twice — once for the pass boolean, once for the detail
// string — non-atomically, so a transient lock on the first call and a clean second
// call produced a false FAIL with a contradictory "ok" detail (see F-R0-9). Callers
// must invoke this once and reuse the returned value for both pass and detail.
// Verified against a live candidate: -readonly requires the -shm/-wal files to
// already exist, and when the app is between writes (fully checkpointed, which is
// the common idle state) those files are absent, so -readonly fails outright with
// SQLITE_CANTOPEN (empty stdout, no "locked"/"busy" in stderr) on an otherwise
// healthy database. Retry without -readonly on subsequent attempts as a fallback —
// a bare SELECT/PRAGMA still does not block the app's WAL writer.
const dbFile = join(supportDir, "default/project.db");
const sqlite = (sql, attempts = 3) => {
  let stdout = "";
  for (let i = 0; i < attempts; i += 1) {
    const args = i === 0 ? ["-readonly", dbFile, sql] : [dbFile, sql];
    const result = sh("sqlite3", args);
    stdout = result.stdout.trim();
    if (stdout !== "") return stdout;
    if (i < attempts - 1) sleep(500);
  }
  return stdout;
};
const alive = () => sh("pgrep", ["-f", `${appName}.app/Contents/MacOS/tripcut-studio`]).status === 0;

// 0. 候选活着、前台
check("process.alive", alive(), "pgrep");
if (!checks[checks.length - 1].pass) {
  // 进程已经不在了:后面每一步 UI 操作对着一个不存在的进程发 AppleEvent,不会有意义
  // 的返回,只会拖慢到 osa() 的超时。提前收尾,直接把这次运行判定为 FAIL。
  const gate = { schemaVersion: 1, gate: "smoke-gui", capturedAt: new Date().toISOString(), candidateDir, supportDir,
    status: "FAIL", checks };
  writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  console.log(`FAIL ${outDir} (候选进程已不存在,跳过后续 UI 步骤)`);
  process.exit(1);
}
osa(`tell application "${appName}" to activate`); sleep(1500);
const keys = (text) => osa(`tell application "System Events" to keystroke "${text}"`);
const key = (code, mods = "") => osa(`tell application "System Events" to key code ${code}${mods ? ` using {${mods}}` : ""}`);
// 截图只走"按窗口 id 截这一个窗口"这一条路。全屏截图**不可用**:实测另一个 app
// 的窗口会在 window-server 层盖在前台 app 之上,拍出来是别人的内容(上一轮真机
// 拍到了业主的邮箱),既不是证据也是隐私事故。拿不到窗口 id 就如实记 SKIP。
// 拿窗口 id 需要 Screen Recording 权限:没有它 CGWindowListCopyWindowInfo 返回空,
// 这个权限不能由程序申请,得人去「系统设置 → 隐私与安全性 → 屏幕录制」里给。
const windowIdOf = () => {
  const pid = sh("pgrep", ["-f", `${appName}.app/Contents/MacOS/tripcut-studio`]).stdout.trim().split("\n")[0];
  if (!pid) return null;
  const jxa = `ObjC.import('CoreGraphics');
const list = $.CGWindowListCopyWindowInfo(1 | 16, 0);
let out = 'none';
if (list && list.js) {
  for (const w of list.js) {
    if (Number(w.kCGWindowOwnerPID.js) !== ${Number(pid)}) continue;
    if (Number(w.kCGWindowLayer.js) !== 0) continue;
    out = String(Number(w.kCGWindowNumber.js));
    break;
  }
}
out`;
  const result = sh("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 15000 });
  const id = result.stdout.trim();
  return id && id !== "none" ? id : null;
};
let screenRecordingMissing = false;
const shot = (n, name) => {
  const id = windowIdOf();
  const file = join(outDir, `${String(n).padStart(2, "0")}-${name}.png`);
  if (!id) {
    screenRecordingMissing = true;
    checks.push({ id: `shot.${name}`, pass: true, skip: true, detail: "SKIP: screen recording permission missing" });
    console.log(`SKIP shot.${name} screen recording permission missing`);
    return false;
  }
  sh("screencapture", ["-x", "-o", "-l", id, file]);
  const ok = existsSync(file);
  checks.push({ id: `shot.${name}`, pass: ok, detail: ok ? `window ${id}` : `screencapture -l ${id} 没有产出文件` });
  console.log(`${ok ? "PASS" : "FAIL"} shot.${name} ${ok ? `window ${id}` : "no file"}`);
  return ok;
};
// System Events 认的是可执行文件进程名(tripcut-studio),不是 `tell application` 用的
// LaunchServices 显示名(旅剪工作台 QA)——两者不能混用。
const uiProcess = "tripcut-studio";
const entireContents = () => osaSlow(`tell application "System Events" to tell process "${uiProcess}" to get entire contents of window 1`).stdout;
const containsText = (needle) => entireContents().includes(needle);

// 0.5 每个新建 support 目录的候选首次启动都会盖两层引导浮层:FirstRunGuide(组件自检)
// 与 SetupWizard(欢迎向导)。⌘K 的按键能穿透到底层 React 应用(路由确实会变),
// 但截图拍到的永远是浮层——不点掉,六张"页面截图"其实是同一张浮层,是假阳性。
// 用已核实的可访问性路径按钮点掉;窗口的可访问性树在 activate 后并非立即可查询
// (首次曾在 1.5s 处报 -1719/-1728 无效索引,稳定后立刻能点中),所以带重试而不是
// 单发 + 定长 sleep。找不到就放弃(未来版本浮层结构变了不应让整个冒烟死在这一步)。
const dismissOverlay = (buttonName, groupPath, label, attempts = 8) => {
  const script = `tell application "System Events" to tell process "${uiProcess}" to click button "${buttonName}" of ${groupPath} of window 1`;
  for (let i = 0; i < attempts; i += 1) {
    const result = osa(script);
    if (result.status === 0) {
      console.log(`PASS onboarding.dismiss.${label}`);
      checks.push({ id: `onboarding.dismiss.${label}`, pass: true, detail: `dismissed after ${i + 1} attempt(s)` });
      return true;
    }
    sleep(500);
  }
  // Non-fatal: a future overlay-structure change shouldn't fail the whole smoke run over
  // one dismiss button, but it must still show up in gate.json instead of only in the
  // console log, otherwise a silently-stuck overlay is invisible to anyone reading the gate.
  console.log(`WARN onboarding.dismiss.${label} gave up after ${attempts} attempts`);
  checks.push({ id: `onboarding.dismiss.${label}`, pass: true, warn: true, detail: `gave up after ${attempts} attempts` });
  return false;
};
dismissOverlay("暂时进入工作台", `group 3 of group "先把本地工具链接好" of UI element 1 of scroll area 1 of group 1 of group 1`, "first-run-guide");
sleep(800);
dismissOverlay("开始使用", `group 4 of group "安装向导" of UI element 1 of scroll area 1 of group 1 of group 1`, "setup-wizard");
sleep(800);
check("onboarding.cleared", !containsText("欢迎使用旅剪工作台") && !containsText("先把本地工具链接好"), "两层首启浮层均已关闭");


// 点击器:按可访问名称在整棵窗口树里找第一个"名字包含 label"的元素并 AXPress。
// 比硬编码 group 路径慢,但不依赖具体嵌套层级,布局一变不会变成静默的空点击。
// 顶栏按钮在真机上是 AXPopUpButton 而不是 AXButton(r8-realcheck3 §3),所以这里
// 刻意不挑角色 —— 写死 `click button "…"` 会在真机上一个都点不中。
const clickByLabel = (label, attempts = 4) => {
  const escaped = label.replaceAll('"', '\\"');
  // 必须先把 entire contents 绑到变量再遍历。内联写法(repeat with elem in
  // (entire contents of window 1))照样跑完上千个元素,但每个 elem 的 name 都读不出来
  // ——实测同一棵树:绑变量版数到 643 个有名字的元素,内联版数到 0,于是永远返回
  // notfound。那是一个只会静默失败的点击器。
  const script = `tell application "System Events" to tell process "${uiProcess}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) contains "${escaped}" then
        perform action "AXPress" of elem
        return "clicked"
      end if
    end try
  end repeat
  return "notfound"
end tell`;
  for (let i = 0; i < attempts; i += 1) {
    const result = osaSlow(script);
    if (result.status === 0 && result.stdout.trim() === "clicked") return true;
    sleep(300);
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. 单屏工作区(规格 §1、§7、§8)
//
// 旧版这里是"点侧栏四步导航 → 逐页断言"。R8 起没有页面了:一屏三栏常驻,导入/
// 交付是抽屉,设置是 sheet。顶栏四个按钮的可访问名称由 `src/workspace/TopBar.tsx`
// 写死,并由 `src/workspace/axNames.test.tsx` 的冻结串用例锁住 —— 改一个字那条
// 单测立刻红,提醒改这里,而不是让本脚本在某个深夜自己找不到按钮。
//
// 真机实测(.superpowers/sdd/r8-realcheck3-report.md §3):这四个按钮在 AX 里
// 报的角色是 **AXPopUpButton**,不是 AXButton。所以一律用 `clickByLabel`
// (按名字找、AXPress 按下,不挑角色),不要写 `click button "导入素材"`。
// ─────────────────────────────────────────────────────────────────────────────

const TOPBAR_BUTTONS = ["导入素材", "切换集", "生成交付包", "设置"];

/**
 * 关抽屉 / sheet。**不用 Esc**:真机实测(R8 收尾轮)交付抽屉开着按 Esc 关不掉,
 * 而抽屉是 `aria-modal="true"` —— 顶栏整个从 AX 树里消失(实测树从 118 KB 缩到
 * 11 KB,连「设置」两个字都不在了),键盘那条路一断,后面每一步都点不中。
 * 这一轮因此给 `Drawer` 加了可见的「关闭」按钮与可点的遮罩,冒烟走按钮这条路。
 * 关不掉就地记 FAIL —— 关不掉本身就是"用户被困在抽屉里"这件事。
 */
const closeModal = (id) => {
  const closed = clickByLabel("关闭");
  sleep(900);
  const back = exactNames().has("镜头带");
  check(`modal.${id}.close`, closed && back, `关闭按钮点中=${closed} 回到工作区(镜头带 landmark 回来)=${back}`);
};
const PANES = ["媒体池", "预览监视器", "镜头带", "检查器"];

/** 某个可访问名称对应元素的 AX 角色(拿不到返回空串)。用来记录而不是判定。 */
const roleOf = (label) => {
  const escaped = label.replaceAll('"', '\\"');
  const script = `tell application "System Events" to tell process "${uiProcess}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "${escaped}" then return (class of elem) as text
    end try
  end repeat
  return ""
end tell`;
  return osaSlow(script).stdout.trim();
};

// 窗口里全部元素的**精确** AX 名(一次遍历)。landmark 断言必须按精确名判,不能用
// `entire contents` 的字符串包含:校准跑(把 `aria-label="镜头带"` 改成 `镜头带2` 再打包
// 冒烟)证明过,`includes("镜头带")` 对着 `镜头带2` 和 `镜头带附属视图` 照样为真,
// 断言根本不会红 —— 那是一条永远绿的空断言,不是探测器。
const exactNames = () => {
  const script = `tell application "System Events" to tell process "${uiProcess}"
  set elems to entire contents of window 1
  set out to ""
  repeat with elem in elems
    try
      set n to (name of elem)
      if n is not "" then set out to out & n & linefeed
    end try
  end repeat
  return out
end tell`;
  return new Set(osaSlow(script).stdout.split("\n").map((line) => line.trim()).filter(Boolean));
};

// 一次读树,四个 landmark + 状态条一起判 —— 分五次读会在树变大后拖成五倍时间。
{
  const names = exactNames();
  const tree = entireContents();
  for (const pane of PANES) {
    check(`workspace.panes.${pane}`, names.has(pane), `精确 AX 名「${pane}」在树里`);
  }
  check("statusbar.present", names.has("后台状态"), "精确 AX 名「后台状态」");
  // 负向证据:旧壳确实下线了。单看它是空心的(整页空白也"不包含"),所以与上面
  // 四个 landmark 同一份树 —— 四个都在而旧名不在,才说明是新壳。
  check(
    "workspace.single_screen",
    !names.has("01 导入 INGEST") && !tree.includes("01 导入 INGEST") && names.has("镜头带"),
    "旧导航名 01 导入 INGEST 不在树里;镜头带 landmark 仍在",
  );
  const roles = TOPBAR_BUTTONS.map((name) => `${name}=${roleOf(name) || "?"}`).join(" ");
  const allPresent = TOPBAR_BUTTONS.every((name) => names.has(name));
  check("topbar.buttons.present", allPresent, roles);
}
shot(1, "workspace-default");

// ─────────────────────────────────────────────────────────────────────────────
// 2. 镜头带附属带(规格 §3.4)。旧版这三条是 WARN —— 它们挂在「故事板」标签那条
// 从没走查过的 AX 路径上。现在五个 tab 的名字是冻结串(`BandTabs`,
// role=tablist "镜头带附属视图"),真机实测 tab 在 AX 里是 AXRadioButton,
// `clickByLabel` 的 AXPress 对它有效。三条**升为硬断言**。
//
// 交互密集的步骤全部排在"选中素材"之前:真机实测一旦有素材载入监视器并开播,
// 窗口的 AX 树会从 ~15 KB 涨到 ~274 KB,`clickByLabel` 那种遍历全树的点击器会
// 从秒级退化到分钟级(r8-realcheck3 §5 实测 >200s 未完成)。
// ─────────────────────────────────────────────────────────────────────────────

const bandTab = (label, needle, id) => {
  const clicked = clickByLabel(label);
  sleep(900);
  const visible = containsText(needle);
  check(id, clicked && visible, `tab点中=${clicked} ${needle}=${visible}`);
  return visible;
};

bandTab("模板", "电影感", "band.template.content");
bandTab("旅程", "旅程时间线", "band.journey.content");
bandTab("音乐", "音乐与节奏", "band.music.content");
shot(5, "band-music");

// 缺口卡片依赖种子库里真的有未覆盖槽位 —— 数据条件,不是代码条件,维持 WARN。
{
  const gapVisible = containsText("缺口");
  checks.push({ id: "band.gap.slot", pass: true, warn: !gapVisible, detail: `缺口=${gapVisible}` });
  console.log(`${gapVisible ? "PASS" : "WARN"} band.gap.slot 缺口=${gapVisible}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 顶栏集切换 → 重命名本集 → 目标平台(规格 §8 迁移表,WARN 升硬断言)。
// 旧版靠侧栏 EpisodePanel 那个名字会随数据漂移的抽屉开关("CURRENT EPISODE ▸" +
// 集标题 + 平台徽章),所以只能 WARN。现在入口是顶栏的固定 AX 名 `切换集`。
// ─────────────────────────────────────────────────────────────────────────────
{
  const switcherClicked = clickByLabel("切换集");
  sleep(700);
  const renamePresent = containsText("重命名本集");
  let platformVisible = false;
  if (renamePresent) {
    clickByLabel("重命名本集");
    sleep(700);
    platformVisible = containsText("目标平台");
  }
  check(
    "topbar.episode.rename",
    switcherClicked && renamePresent && platformVisible,
    `切换集点中=${switcherClicked} 重命名本集=${renamePresent} 目标平台=${platformVisible}`,
  );
  key(53); // Esc 关 popover
  sleep(400);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 导入抽屉(规格 §1)。旧 `page.import.*` → `drawer.import.*`。
// ─────────────────────────────────────────────────────────────────────────────
{
  const opened = clickByLabel("导入素材");
  sleep(1200);
  const tree = entireContents();
  check("drawer.import.open", opened && tree.includes("导入素材"), `点中=${opened}`);
  for (const tab of ["来源", "任务", "缺失素材"]) {
    check(`drawer.import.tab.${tab}`, tree.includes(tab), `分页 ${tab}`);
  }
  // 负向断言:拖放遮罩只在 dragActive 时渲染,静置态不该在树里。单看是空心的
  // (抽屉压根没开也"不包含"),所以同一次读里顺带断言抽屉标题还在。
  check(
    "drawer.import.dropOverlay.hidden",
    !tree.includes("松开即导入") && tree.includes("导入素材"),
    "松开即导入 不在树里;抽屉标题「导入素材」在",
  );
  shot(2, "drawer-import");
  closeModal("import");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 交付抽屉。`drawer.deliver.platform` 硬断言;`drawer.deliver.contact` 也是
// 硬断言 —— R4 Task 3 的前端接线没上时它会如实 FAIL,不做成 WARN 掩盖。
// ─────────────────────────────────────────────────────────────────────────────
{
  const opened = clickByLabel("生成交付包");
  sleep(1200);
  const tree = entireContents();
  check("drawer.deliver.open", opened, `点中=${opened}`);
  check("drawer.deliver.platform", tree.includes("本次交付平台"), "本次交付平台");
  check("drawer.deliver.contact", tree.includes("联系表"), "联系表(R4 Task 3 前端接线未上时预期 FAIL)");
  shot(3, "drawer-deliver");
  closeModal("deliver");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 设置 sheet。两个分区都是常驻渲染的 section 标题,侧栏只是 scrollIntoView,
// 不需要额外点击。
// ─────────────────────────────────────────────────────────────────────────────
{
  const opened = clickByLabel("设置");
  sleep(1400);
  const tree = entireContents();
  check("sheet.settings.open", opened, `点中=${opened}`);
  check("sheet.settings.privacy", tree.includes("隐私与诊断"), "隐私与诊断");
  check("sheet.settings.generation", tree.includes("云端补镜"), "云端补镜");
  shot(4, "sheet-settings");
  closeModal("settings");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 选中一条素材 → 检查器分层(规格 §4)。旧版这两条是 WARN 且要先导航回筛片页;
// 现在检查器常驻右栏,选中后两个折叠段的 `summary` 常驻(不需要展开),**硬断言**。
//
// 选中的办法:媒体池卡片的可访问名是 `{文件名} · {时长} · {评级}`
// (`poolModel.clipAriaLabel`),文件名从隔离库里读 —— 比"按 ↓ 指望网格恰好有焦点"
// 可靠得多。这一步之后 AX 树会涨到几十万字符,所以它排在所有点击步骤之后。
// ─────────────────────────────────────────────────────────────────────────────
// `clips` 表里没有 `file_name` 列 —— 文件名是 Rust 侧从 `rel_path` 取的 basename
// (上一轮探针照着前端类型写了 `file_name`,sqlite3 直接 parse error,stdout 为空,
// 于是报成"库里没有素材",而同一次运行的 db.clips 数到 500 条。查列名,别查类型定义。)
const firstClipName = (sqlite("SELECT rel_path FROM clips ORDER BY id LIMIT 1") || "")
  .split("/")
  .pop();
{
  const clicked = firstClipName ? clickByLabel(firstClipName) : false;
  sleep(1500);
  const tree = entireContents();
  check("pool.select.first", clicked, `文件名=${firstClipName || "(库里没有素材)"}`);
  check("inspector.similar.content", tree.includes("相似镜头"), "相似镜头");
  check("inspector.techcheck.content", tree.includes("技术检查"), "技术检查");
  shot(6, "inspector-expanded");
}

// 键盘评级:媒体池获焦(上一步点中卡片即获焦)后按 F。仍以 ratings 行数判定,
// 维持 WARN —— 键盘焦点落点受窗口状态影响,不该把整条流水线拖红。
{
  const before = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
  keys("f");
  sleep(900);
  const after = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
  checks.push({ id: "pool.rate.f", pass: true, warn: after <= before, detail: `${before}->${after}` });
  console.log(`${after > before ? "PASS" : "WARN"} pool.rate.f ${before}->${after}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 库自检(single sqlite3 call per check,见文件头 sqlite() 的注释:早先版本
// 同一条断言调两次 sqlite,撞上 WAL 写入就产出"FAIL + detail 却是 ok"的假红,F-R0-9)
// ─────────────────────────────────────────────────────────────────────────────
const integrityResult = sqlite("PRAGMA integrity_check");
check("db.integrity", integrityResult === "ok", integrityResult);
const clipsResult = sqlite("SELECT COUNT(*) FROM clips");
check("db.clips", Number(clipsResult || 0) > 0, clipsResult);
check("process.alive.end", alive(), "");

if (screenRecordingMissing) {
  console.log(
    "NOTE 本轮截图全部 SKIP:驱动进程没有「屏幕录制」权限,CGWindowListCopyWindowInfo 返回空。" +
      "去「系统设置 → 隐私与安全性 → 屏幕录制」给跑本脚本的那个 app 勾上,再重跑。",
  );
}

const gate = { schemaVersion: 1, gate: "smoke-gui", capturedAt: new Date().toISOString(), candidateDir, supportDir,
  status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks };
writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
console.log(`${gate.status} ${outDir}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
