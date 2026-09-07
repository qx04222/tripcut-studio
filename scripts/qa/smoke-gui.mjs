#!/usr/bin/env node
// GUI 冒烟:对 CUA 候选实例用 ⌘K 逐页跳转、截图、键盘评级,判定用隔离库行数与进程存活。
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
const shot = (n, name) => { const p = join(outDir, `${String(n).padStart(2, "0")}-${name}.png`); sh("screencapture", ["-x", p]); return existsSync(p); };
// System Events 认的是可执行文件进程名(tripcut-studio),不是 `tell application` 用的
// LaunchServices 显示名(旅剪工作台 QA)——两者不能混用。
const uiProcess = "tripcut-studio";
const entireContents = () => osa(`tell application "System Events" to tell process "${uiProcess}" to get entire contents of window 1`).stdout;
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

// 1. 六页跳转
// 注(两处偏离 brief 原稿,均已现场核实,不是猜测):
// (a) brief 假定五页(import/select/story/deliver/settings)。实查 src/App.tsx 与
//     src/CommandPalette.tsx,产品只有四页(导入/筛片/交付/设置),没有独立的"故事"页
//     ("故事选择"只是筛片页里的一句副标题文案,不是命令面板可跳转项)。改为四页各
//     访问一次,并在评级步骤前重访筛片页两次,凑满六张硬性截图断言。
// (b) brief 假定 ⌘K → keystroke 中文页名 → Return 可靠。实测不成立:System Events
//     的 keystroke 命令按当前(拉丁字母)键盘布局逐键发送,中文字符不在映射表里,
//     结果是乱码("导入"/"筛片"等全部键入成同一个 "aa"),六张截图变成同一张
//     "没有匹配项" 的命令面板。命令面板本身也没有英文/拼音关键词可退回(cmdk 的
//     value 取自渲染文本,是纯中文)。改用侧边栏"工作流导航"的可访问性直接点击
//     ——那四个导航项的 AX 名称自带英文("01 导入 INGEST" 等),点击不经过键盘布局,
//     跳转是真实发生的(sidebar 高亮跟着变,不是同一张浮层的重复照片)。
// Fragile-index note (task-5-report.md §3(b)): these AX paths (navGroup, and the
// dismissOverlay groupPath literals above) were hand-derived by walking the live
// accessibility tree after ⌘K + Chinese keystroke turned out to send mojibake
// (System Events keystroke follows the Latin keyboard layout, not the rendered
// text) — they are not from the brief, and they will silently stop matching if
// the sidebar/onboarding DOM structure changes. Re-derive via `osascript -e
// 'tell application "System Events" to tell process "tripcut-studio" to get
// entire contents of window 1'` before trusting a FAIL here.
const navGroup = `group "工作流导航" of group 1 of UI element 1 of scroll area 1 of group 1 of group 1`;
const clickNav = (axName, attempts = 6) => {
  const script = `tell application "System Events" to tell process "${uiProcess}" to click UI element "${axName}" of ${navGroup} of window 1`;
  for (let i = 0; i < attempts; i += 1) {
    const result = osa(script);
    if (result.status === 0) return true;
    sleep(400);
  }
  return false;
};
// R2-R4 additions need to click things that (unlike the sidebar nav items above) were
// never hand-walked against a live tree in this session — the 「故事板」 tab, the dynamic
// "CURRENT EPISODE" drawer toggle, and 「重命名本集」. Rather than guess a full group path
// (wrong path -> silent no-op click, not a loud failure) this searches the whole window's
// `entire contents` for any element whose accessible name *contains* the label and presses
// it directly via AXPress. Slower than a hard-coded path but does not depend on exact
// nesting, so it survives layout changes and dynamic text (the drawer toggle's name is
// "CURRENT EPISODE ▸/▾" + the current episode title, never a fixed string).
const clickByLabel = (label, attempts = 4) => {
  const escaped = label.replaceAll('"', '\\"');
  // 必须先把 entire contents 绑到变量再遍历。内联写法(repeat with elem in
  // (entire contents of window 1))照样跑完 1200 个元素,但每个 elem 的 name 都读不出来
  // ——实测同一棵树:绑变量版数到 643 个有名字的元素,内联版数到 0,于是永远返回
  // notfound。那是一个只会静默失败的点击器(smoke-gui 里这两条断言长期是 WARN,
  // 原因就在这)。
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
    const result = osa(script);
    if (result.status === 0 && result.stdout.trim() === "clicked") return true;
    sleep(300);
  }
  return false;
};
// page.*.shot only proves a PNG was written — a blank/white window still produces a
// valid screenshot file, so it cannot catch a route that rendered nothing. Each page
// carries its own "kicker" header string (src/App.tsx ROUTE_COPY, one per RoutePath)
// that appears nowhere else in the app; page.*.content asserts it is actually present
// in the AX tree after navigating, so a white/stuck page fails here even though the
// screenshot still exists.
const pageContent = {
  import: "素材入口",
  select: "故事选择",
  deliver: "成片出口",
  settings: "工作台控制",
};
const pages = [
  ["import", "01 导入 INGEST"],
  ["select", "02 筛片 SELECT"],
  ["deliver", "03 交付 DELIVER"],
  ["settings", "04 设置 SETTINGS"],
  ["import2", "01 导入 INGEST"],
  ["select2", "02 筛片 SELECT"],
];
pages.forEach(([id, axName], i) => {
  const clicked = clickNav(axName);
  sleep(1000);
  check(`page.${id}.nav`, clicked, axName);
  check(`page.${id}.shot`, shot(i + 1, id), axName);
  const expected = pageContent[id.replace(/\d+$/, "")];
  check(`page.${id}.content`, containsText(expected), expected);
  check(`page.${id}.alive`, alive(), "");
});

// 1.5 R2-R4 内容断言:六页跳转只证明路由变了(kicker 文案),不证明 R2-R4 加的具体面板/
// 控件真的渲染出来。下面每条都断言一个模块专属字符串,取自组件源码(见各注释里的文件行),
// 不是从截图猜的。

// R2:「相似镜头」「技术检查」是筛片页右侧检查器(SelectionInspector)里的两个 section
// 标题(src/SelectPage.tsx:999-1000,标题分别来自 src/SimilarGroupsPanel.tsx:64 与
// src/TechCheckPanel.tsx:168)。检查器只在选中一条素材后才渲染(clip 非空才走到这段
// JSX),胶片墙默认没有选中项,所以要先按一次 ↓ 选中首条(种子库有 8 条素材)。
clickNav("02 筛片 SELECT");
sleep(600);
key(125); sleep(800);
check("select.similar.content", containsText("相似镜头"), "相似镜头");
check("select.techcheck.content", containsText("技术检查"), "技术检查");

// R4 Task 5:「电影感」是故事板顶部四选一模板卡片之一(src/StoryboardChapterTitle.test.tsx:147
// 印证文案;卡片渲染在 src/Storyboard.tsx,由筛片页的「故事板」标签切换进,src/SelectPage.tsx:1955)。
// 「故事板」标签是一个普通 <button>,可访问名称由其可见文本拼成,没有在真实 AX 树里核实过
// (不同于文件头部 navGroup/dismissOverlay 那几条——那些是走查过活树的),所以整条断言按 brief
// 要求降级为 WARN-only:点不中或点中了但没看到「电影感」都不让整个冒烟 FAIL,只在 detail 里
// 如实记录,免得一次不可靠的 AX 路径把整条流水线拖红。
const storyTabClicked = clickByLabel("故事板");
sleep(600);
const cinematicVisible = containsText("电影感");
{
  const ok = storyTabClicked && cinematicVisible;
  checks.push({ id: "select.storyboard.template", pass: true, warn: !ok, detail: `tab点中=${storyTabClicked} 电影感=${cinematicVisible}` });
  console.log(`${ok ? "PASS" : "WARN"} select.storyboard.template tab点中=${storyTabClicked} 电影感=${cinematicVisible}`);
}

// R6 Task 6 G8:「旅程时间线」是故事板右侧新增的只读时间线标签
// (src/Storyboard.tsx,与「音乐与节奏」并列;组件本体 src/JourneyTimeline.tsx)。
// 同上一条一样依赖「故事板」标签的不稳定 AX 路径,降级为 WARN-only。
{
  const journeyVisible = containsText("旅程时间线");
  checks.push({ id: "select.storyboard.journey_timeline", pass: true, warn: !journeyVisible, detail: `旅程时间线=${journeyVisible}` });
  console.log(`${journeyVisible ? "PASS" : "WARN"} select.storyboard.journey_timeline 旅程时间线=${journeyVisible}`);
}

// R5:「音乐与节奏」是故事板标签页里与「旅程时间线」并列的另一个 tab(见上一条注释)。
// 同样依赖未走查过的「故事板」标签 AX 路径,降级为 WARN-only,不阻塞冒烟。
{
  const musicVisible = containsText("音乐与节奏");
  checks.push({ id: "select.storyboard.music", pass: true, warn: !musicVisible, detail: `音乐与节奏=${musicVisible}` });
  console.log(`${musicVisible ? "PASS" : "WARN"} select.storyboard.music 音乐与节奏=${musicVisible}`);
}

// R4 Task 3:「本次交付平台」是交付页的临时覆盖平台下拉(src/DeliverPage.tsx:173-175),硬断言,
// 常驻渲染不需要额外交互。「联系表」断言的是交付包内容预览要列出联系表 PDF 这一项——按
// R4 计划 Task 3 (docs/superpowers/plans/2026-09-06-r4-contact-sheet-templates.md) 应该
// 接到 src/DeliverPage.tsx,但截至本次改动,仓库里合并的只有 Task 2(src-tauri/src/core/
// contact_sheet.rs 的 printpdf 渲染本体,commit 666e340),Task 3 的前端接线还没有落地
// (src/DeliverPage.tsx 里目前没有任何 checkbox,也没有「联系表」三个字)。按 brief 原样加成
// 硬断言:接线上线前这条会如实 FAIL,不做成 WARN 掩盖——FAIL 就是「前端还没接」这件事本身
// 的正确信号,接上后自然转绿。
clickNav("03 交付 DELIVER");
sleep(800);
check("deliver.platform.content", containsText("本次交付平台"), "本次交付平台");
check("deliver.contact.content", containsText("联系表"), "联系表(Task 3 前端接线未上时预期 FAIL,见上方注释)");

// 设置页:「隐私与诊断」是常驻渲染的 section 标题(src/SettingsPage.tsx:995),侧栏导航只是
// scrollIntoView,不是 tab 切换,所有 section 一直都在 AX 树里,无需额外点击。
clickNav("04 设置 SETTINGS");
sleep(800);
check("settings.privacy.content", containsText("隐私与诊断"), "隐私与诊断");

// 导入页负向断言:拖放遮罩(src/ImportPage.tsx:660-663)只在 dragActive 时渲染,静置状态下
// 「松开即导入」不应该出现在 AX 树里。单看这一条是空心的——一个整页空白/卡死的页面同样会
// "不包含"这串文字,所以顺带断言 kicker(「素材入口」,与 pageContent.import 用的是同一串)
// 仍然在,证明这不是页面死了导致的假阳性阴性。
clickNav("01 导入 INGEST");
sleep(800);
check("import.dropOverlay.hidden", !containsText("松开即导入") && containsText("素材入口"), "松开即导入 应不可见;素材入口 kicker 应仍在");

// 侧栏 EpisodePanel(src/EpisodePanel.tsx,每个页面左侧都常驻):「目标平台」下拉
// (EpisodePanel.tsx:186-188)只在重命名表单展开时渲染,表单本身又要先展开集抽屉才能看到
// 「重命名本集」按钮(抽屉默认收起,EpisodePanel.tsx:45 `useState(false)`)。抽屉切换按钮的
// 可访问名称是动态拼出来的("CURRENT EPISODE ▸/▾" + 当前集标题 + 平台徽章),同样没有走查过
// 活树,所以整条按 brief 要求降级为 WARN-only:只有先在 AX 树里看到「重命名本集」按钮,才会
// 点它、断言「目标平台」、再按 Esc 收尾;抽屉本身点不开就直接记 WARN,不阻塞冒烟。
const episodeDrawerClicked = clickByLabel("CURRENT EPISODE");
sleep(500);
const renameButtonPresent = containsText("重命名本集");
let platformFieldVisible = false;
if (renameButtonPresent) {
  clickByLabel("重命名本集");
  sleep(500);
  platformFieldVisible = containsText("目标平台");
  key(53); // Esc,退出重命名表单
  sleep(300);
}
{
  const ok = renameButtonPresent && platformFieldVisible;
  checks.push({ id: "episode.renamePlatform.field", pass: true, warn: !ok,
    detail: `抽屉点中=${episodeDrawerClicked} 重命名按钮可见=${renameButtonPresent} 目标平台=${platformFieldVisible}` });
  console.log(`${ok ? "PASS" : "WARN"} episode.renamePlatform.field 抽屉点中=${episodeDrawerClicked} 重命名按钮可见=${renameButtonPresent} 目标平台=${platformFieldVisible}`);
}

// R5 调查结论(不新增断言,记录在此免得下一轮重新踩坑):侧栏全量搜索(src/SidebarSearch.tsx,
// 挂在 src/App.tsx:191,每页常驻)的结果列表只在 query.trim().length >= 2 时才请求/渲染
// (SidebarSearch.tsx 的 useEffect),要么靠用户输入,要么靠 `tripcut:search` 这个
// window CustomEvent。当前冒烟流程里没有任何一步点进过这个搜索框或往里打过字——
// 现有的 clickNav/clickByLabel/keys 都没有以它为目标,且 keys() 走 System Events 的
// keystroke,对中文查询词(比如按文件名/转写内容检索到 OCR 命中)一样会撞上命令面板
// 那条注释里记录的乱码问题(见 145 行上方的 (b) 说明)。因此判定:搜索结果面板在
// 「当前冒烟流程」里不可达,不加 R5 要求的「画面文字」kind 断言——加断言前得先加一条
// 新的"点中搜索框→打字→等 debounce"AX 交互,那是超出本轮调查范围的新增基建。

// 2. 筛片页键盘评级(可选断言:失败降级为 warn,R2 加固)
// 上面 R2-R4 断言块末尾把页面导航停在了导入页(episode 断言之后),这里的评级操作要求当前
// 在筛片页且胶片墙有一条素材处于选中态,所以先导航回去,不能假设仍在筛片页上。
clickNav("02 筛片 SELECT");
sleep(800);
const ratingsBefore = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
key(125); sleep(300); keys("f"); sleep(800);      // ↓ 选中首条,F 收藏
const ratingsAfter = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
checks.push({ id: "select.rate.f", pass: true, warn: ratingsAfter <= ratingsBefore, detail: `${ratingsBefore}->${ratingsAfter}` });
console.log(`${ratingsAfter > ratingsBefore ? "PASS" : "WARN"} select.rate.f ${ratingsBefore}->${ratingsAfter}`);

// 3. 库自检 (single sqlite3 call per check, result reused for pass and detail — see
// the sqlite() comment above for why: a prior double-call version raced the app's
// WAL writes and produced a false FAIL with a contradictory "ok" detail, F-R0-9)
const integrityResult = sqlite("PRAGMA integrity_check");
check("db.integrity", integrityResult === "ok", integrityResult);
const clipsResult = sqlite("SELECT COUNT(*) FROM clips");
check("db.clips", Number(clipsResult || 0) > 0, clipsResult);
check("process.alive.end", alive(), "");

const gate = { schemaVersion: 1, gate: "smoke-gui", capturedAt: new Date().toISOString(), candidateDir, supportDir,
  status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks };
writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
console.log(`${gate.status} ${outDir}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
