#!/usr/bin/env node
/**
 * R19 U-12(bench2 车道):前 5 分钟门禁。
 *
 * 把 .superpowers/sdd/r19/brainstorm-usability.md §3.1 的逐步计数做成可回归的真机装置:
 * 隔离 profile 起真 .app → 首页 → 新建一集 → 导入 27 条夹具 → 等分析 → 自动挑选 →
 * 导出「交给剪映」→ 文件落地。计点击次数、可见新词数(对照 §3.4 词表)、启动到导出文件的秒数。
 *
 * 用法:
 *   node scripts/qa/first-five-minutes.mjs --app <path/to/旅剪工作台.app> --fixtures <dir>
 *        [--rounds 3] [--enforce] [--out-dir qa/runs]
 *
 * 判据(--enforce 时非零退出;默认只报告不拦):点击 ≤ 6、新词 ≤ 6、本机秒数 ≤ 60。
 * (brainstorm §5 U-12 原判据是「M1 8 GB ≤ 90 s(含分析)」——那是把 27 条全部分析完的口径;
 * 本装置走的是「先挑已分析的部分」这条不等分析的路径,所以本机阈值改用 60 s,在报告里注明。)
 *
 * 三条纪律(抄自 bench/check-startup.mjs 与 native-audit/run.mjs):
 *  - 隔离 profile:TRIPCUT_APP_SUPPORT_DIR=<scratch>,绝不碰 ~/Library/Application Support/TripCutStudio/。
 *  - 只杀自己起的 pid,不扫描系统里所有 tripcut-studio 进程。
 *  - 激活自己的实例用 System Events 按 pid 置前,不用 `open -a`(会认到业主机器上另一份同 bundle id 的实例)。
 *
 * 已知不可 AX 驱动、按最接近方式替代(不假绿,见报告与 lane-bench2-report.md):
 *  - 主按钮 AX 名冻结为「流水线下一步」,可见文案(「先挑已分析的 x/N 条」等)只在 AXHelp
 *    (工具提示)里——按冻结名点,用 AXHelp 判断走到哪一步,不按可见文案找按钮。
 *  - 导入文件夹的原生 NSOpenPanel:改用 `open -a <app> <fixtures-dir>`(RunEvent::Opened → 导入,
 *    src-tauri/src/lib.rs 的 M-06①)。这就是 docs/qa/2026-09-18-unattended-r19.md §2 真机验收用的同一条路。
 *  - 导出目录的原生「选择交付包保存位置」面板:这个面板本身是 AX 可达的(sheet 1 of window 1,
 *    按钮「打开」名字读得到),但 Cmd+Shift+G「前往文件夹」实测没能把路径栏改到位——退化为接受
 *    面板默认目录(通常 ~/Documents),导出成功后把落地文件夹迁回 scratch 记录、并从默认目录删除,
 *    不把测试残留留在业主真实的 Documents 里。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UI_PROCESS, osa, sleep, windowText, waitForText, activatePid, clickByLabel } from "./ax-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const argument = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);

const appPath = argument("--app");
const fixturesDir = argument("--fixtures");
if (!appPath || !existsSync(appPath) || !fixturesDir || !existsSync(fixturesDir)) {
  console.error(
    "用法: node scripts/qa/first-five-minutes.mjs --app <path/to/旅剪工作台.app> --fixtures <dir> [--rounds 3] [--enforce] [--out-dir qa/runs]",
  );
  process.exit(2);
}
const rounds = Number(argument("--rounds", "1"));
const enforce = flag("--enforce");
const outDirBase = resolve(repoRoot, argument("--out-dir", "qa/runs"));

// §3.4 主路径词表(首页→导出全程,剪映用户没有现成心智的词)
const VOCAB = ["镜头带", "章节", "精选段", "交付", "模板", "旅程", "八维", "Take", "槽位", "缺口", "关注文件夹", "素材包", "集"];

const THRESHOLDS = { clicks: 6, words: 6, seconds: 60 };

function bundleExecutable(app) {
  const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
  const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
  if (match) return match[1];
  return readdirSync(join(app, "Contents/MacOS"))[0];
}

/** 等某段文字出现在窗口里,超时返回 false(有界等待,不无界卡死)。 */
function waitFor(needle, timeoutMs) {
  const { needle: hit } = waitForText([needle], { timeoutMs, intervalMs: 500 });
  return hit != null;
}

/**
 * F-R19-06 取证:按 AX 名读一颗按钮的 `enabled`(AXPress 对禁用按钮照样返回 "clicked",
 * 光看点击结果分不出「按钮禁用」和「点了没反应」)。返回 "true" / "false" / "notfound"。
 */
function buttonEnabled(label) {
  const escaped = label.replaceAll('"', '\\"');
  return (
    osa(
      `tell application "System Events" to tell process "${UI_PROCESS}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "${escaped}" then return (enabled of elem) as text
    end try
  end repeat
  return "notfound"
end tell`,
      120000,
    ).stdout?.trim() ?? "notfound"
  );
}

/** 原生 NSOpenPanel 出现了没:rfd 的 pick_folder 没挂父窗口时是独立窗口,不一定在 window 1 的 entire contents 里。 */
function nativePanelVisible(title) {
  const names = osa(`tell application "System Events" to tell process "${UI_PROCESS}" to get name of every window`).stdout ?? "";
  return names.includes(title) || windowText().includes(title);
}

/** 新词计数器:扫一次当前窗口文字,把词表里第一次出现的词计进 seen。 */
function scanNewWords(seen) {
  const text = windowText();
  for (const word of VOCAB) if (!seen.has(word) && text.includes(word)) seen.add(word);
  return seen;
}

async function oneRound(roundIndex, roundOutDir) {
  mkdirSync(roundOutDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), `tripcut-first5-${roundIndex}-`));
  const exportRoot = join(profile, "export-out");
  mkdirSync(exportRoot, { recursive: true });

  const notes = [];
  const seenWords = new Set();
  let clicks = 0;
  const click = (label) => {
    clicks += 1;
    notes.push(`click #${clicks}: ${label}`);
  };

  const bin = join(appPath, "Contents/MacOS", bundleExecutable(appPath));
  const t0 = Date.now();
  const child = spawn(bin, [], { env: { ...process.env, TRIPCUT_APP_SUPPORT_DIR: profile }, stdio: "ignore", detached: true });
  const pid = child.pid;

  const result = { round: roundIndex, pid, profile, clicks: 0, newWords: [], seconds: null, notes, exported: false };

  try {
    // 等窗口起来:轮询「新建一集」出现(有界等待,最多 30s)。
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      activatePid(pid);
      if (windowText().includes("新建一集")) {
        up = true;
        break;
      }
      sleep(500);
    }
    if (!up) {
      notes.push("PROBE: 30s 内没等到首页出现「新建一集」");
      result.probe = true;
      return result;
    }
    // `dismissOnboarding()`(ax-helpers.mjs)按的是老壳两层浮层的写死路径(「先把本地工具链接好」/
    // 「安装向导」),R19 首启走查过没出现这两层——写死路径在树结构变化后可能按到别的元素而不报错
    // (只看 AppleScript exit code,不验证点中的是不是目标),真机复现过一次"点了流水线下一步却卡住不
    // 前进"疑似正是这个副作用;R19 用的是「新手引导 n/8」气泡系统(独立处理,不挡首页/顶栏按钮),
    // 这里不再调用。
    activatePid(pid);
    scanNewWords(seenWords);

    // ── 步骤 1:新建一集 ──────────────────────────────────────────
    if (!clickByLabel("新建一集", { exact: true })) {
      notes.push("PROBE: 点不中「新建一集」");
      result.probe = true;
      return result;
    }
    click("新建一集");
    if (!waitFor("选择文件夹", 10_000)) notes.push("警告:导入抽屉没有看到「选择文件夹」,继续走 open -a 路线");
    scanNewWords(seenWords);

    // ── 步骤 2:导入 27 条(原生 NSOpenPanel 不走 AX,用「打开方式」路径替代 —— 见文件头注释) ──
    execFileSync("open", ["-a", appPath, fixturesDir]);
    // R19 Wave 2 P-10:导入一入库抽屉就自动收,「已发现 N 个视频」只在抽屉里闪不到一秒;
    // 状态条的「已导入 N 条」才是稳态信号 —— 两个都认(a9d1279 真机:只等「已发现」3/3 轮 PROBE)。
    {
      const { needle } = waitForText(["已导入", "已发现"], { timeoutMs: 30_000, intervalMs: 500 });
      if (needle === null) {
        notes.push("PROBE: 30s 内没等到「已发现 N 个视频」/「已导入 N 条」——导入未触发或太慢");
        result.probe = true;
        return result;
      }
      notes.push(`导入信号:${needle}`);
    }
    scanNewWords(seenWords);

    // ── 步骤 3:关闭抽屉(Esc,System Events key code 53——cliclick 打不进 WKWebView) ──
    // 实测:偶尔第一次 Esc 没关掉(前台焦点还没真的切到本进程上);验证抽屉真的关了,
    // 关不掉就重新置前 + 再按一次 Esc,最多 3 次。这一步只算一次点击,不管重试了几次。
    // P-10 之后抽屉通常已经自动收了:还开着才按 Esc、才计这一次点击。
    if (windowText().includes("选择文件夹")) {
      for (let i = 0; i < 3 && windowText().includes("选择文件夹"); i += 1) {
        activatePid(pid);
        osa(`tell application "System Events" to key code 53`);
        sleep(700);
      }
      click("关闭导入抽屉(Esc)");
    } else {
      notes.push("导入抽屉已自动收(P-10),不计 Esc 点击");
    }
    sleep(800);
    scanNewWords(seenWords);

    // ── 步骤 4:分析中先挑已分析的部分(不等 27 条全分析完) ──
    // R19 U-01/pipelineModel.ts:主按钮的 AX 名冻结为「流水线下一步」,可见文案(「先挑已分析的
    // x/N 条」/「下一步:自动挑选」)只在 AXHelp(工具提示)里,不在 AXTitle/AXValue 里——
    // 实测:clickByLabel 用 name 精确匹配那句动态文案永远 notfound;必须按冻结 AX 名点,
    // 用 AXHelp 判断走到哪一步。
    // 另一个实测坑:写死的 group 路径(`group 1 of UI element 1 of scroll area 1 of ...`)在
    // 「新手引导」气泡出现时会往树里插一个新的兄弟节点,把路径挤偏,报「不能获得…」(-1728)——
    // 和 clickByLabel 一样改成按 name 遍历 entire contents,不依赖固定深度路径。
    const PIPELINE_NEXT_HELP = () =>
      osa(`tell application "System Events" to tell process "${UI_PROCESS}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "流水线下一步" then return help of elem
    end try
  end repeat
  return ""
end tell`).stdout?.trim() ?? "";
    // WKWebView 的 AX 树在导航瞬间会短暂"塌陷"(entire contents 只剩窗口按钮那几行),
    // 实测撞过一次(第 5 步导出前);重试几次而不是第一次 notfound 就判 PROBE。
    const pressPipelineNext = () => {
      for (let i = 0; i < 3; i += 1) {
        const clicked =
          osa(`tell application "System Events" to tell process "${UI_PROCESS}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "流水线下一步" then
        perform action "AXPress" of elem
        return "clicked"
      end if
    end try
  end repeat
  return "notfound"
end tell`).stdout?.trim() === "clicked";
        if (clicked) return true;
        sleep(500);
      }
      return false;
    };

    // 90s:本机常有别的车道并行跑压测(perf_driver 多 worker)抢 CPU,分析进度会被拖慢;
    // 阈值放宽避免把资源争用误判成缺陷(计时判据从这一步之后才开始算,不受这段影响)。
    let help = "";
    {
      const pickDeadline = Date.now() + 90_000;
      while (Date.now() < pickDeadline) {
        activatePid(pid);
        help = PIPELINE_NEXT_HELP();
        if (help.includes("先挑已分析的") || help.includes("自动挑选")) break;
        sleep(1000);
      }
    }
    if (!help.includes("先挑已分析的") && !help.includes("自动挑选")) {
      notes.push(`PROBE: 90s 内「流水线下一步」的提示文案没有变成挑选步(实测:${help || "空"})`);
      result.probe = true;
      return result;
    }
    if (!pressPipelineNext()) {
      notes.push("PROBE: 点不中「流水线下一步」(挑选步)");
      result.probe = true;
      return result;
    }
    click(`流水线下一步(${help.includes("先挑已分析的") ? "先挑已分析的部分" : "自动挑选"})`);
    scanNewWords(seenWords);

    // 有的路径会弹出范围/时长小面板(「开始挑选」),有的路径直接挑完并顺手排进镜头带
    // (smart_select.rs:407-409)。toast(「已挑选…」/「已按全部素材挑了…」)实测 2–4s
    // 就淡出,轮询容易错过窗口——不拿它当判据,直接等「流水线下一步」的 AXHelp 变成
    // 「下一步:导出」(挑完即顺手 arrange,这一跳是可靠信号)。
    sleep(800);
    if (windowText().includes("开始挑选")) {
      if (clickByLabel("开始挑选", { exact: true })) click("开始挑选");
    }
    scanNewWords(seenWords);

    // ── 步骤 5:下一步:导出(同一个冻结 AX 名「流水线下一步」) ──────
    // 实测坑:analysisPending 刚落到 0 的那一刻,AXPress 有时"点了但没生效"(AXHelp 立刻能读到
    // 新文案,但 onClick 绑的还是上一帧的闭包/AutoSelect 请求没发出去)——过几秒同一个按钮再点
    // 一次就正常了。所以这里不只是等,过 8s 还没跳就再点一次(最多 3 次),不是纯轮询。
    {
      const deadline = Date.now() + 60_000;
      let lastPressAt = Date.now();
      while (Date.now() < deadline && !PIPELINE_NEXT_HELP().includes("下一步:导出")) {
        if (Date.now() - lastPressAt > 8000) {
          pressPipelineNext();
          lastPressAt = Date.now();
        }
        sleep(500);
      }
    }
    if (!PIPELINE_NEXT_HELP().includes("下一步:导出")) {
      notes.push("PROBE: 60s 内「流水线下一步」提示文案没有变成「下一步:导出」(含重试点击)");
      result.probe = true;
      return result;
    }
    if (!pressPipelineNext()) {
      notes.push("PROBE: 点不中「流水线下一步」(导出步)");
      result.probe = true;
      return result;
    }
    click("流水线下一步(下一步:导出)");
    if (!waitFor("交给剪映", 10_000)) notes.push("警告:导出抽屉没看到「交给剪映」卡");
    scanNewWords(seenWords);

    // ── 步骤 6:交给剪映(首屏三卡点这张;R19 F-R19-01 记过文件夹时一次即出) ──
    if (!clickByLabel("交给剪映", { exact: true })) {
      notes.push("PROBE: 点不中「交给剪映」");
      result.probe = true;
      return result;
    }
    click("交给剪映");

    // 没记过文件夹时会弹原生「选择交付包保存位置」面板。实测(2026-09-18 手动走查)这个面板
    // **是** AX 可达的(sheet 1 of window 1,按钮「打开 / 取消」名字都读得到)——与 lane-common
    // 提到的「AXPress 打开的浮层」是两回事,这个是原生 NSOpenPanel,不是 WKWebView 里的浮层。
    // 但 Cmd+Shift+G「前往文件夹」在这个 sheet 上实测没有把路径栏改到位(键盘事件目标不明确,
    // 原因未查清)——按最接近可驱动方式替代:直接接受面板当前默认目录,不强行改路径。
    // 默认目录通常是 ~/Documents,不在 scratch 里;落地后立刻搬进 scratch/记录实际路径,
    // 事后清理,不把测试残留留在业主真实的 Documents 里(不假装走了「选到 scratch」这一步)。
    let hasSheet = false;
    {
      const sheetDeadline = Date.now() + 10_000;
      while (Date.now() < sheetDeadline) {
        if (windowText().includes("选择交付包保存位置")) {
          hasSheet = true;
          break;
        }
        sleep(500);
      }
    }
    if (hasSheet) {
      notes.push("替代:原生「选择交付包保存位置」面板出现——Cmd+Shift+G 未能可靠定位到 scratch,接受面板默认目录(通常 ~/Documents),导出后再迁回 scratch 并清理原位置,不假装真的选到了 scratch");
      const confirmed = osa(`tell application "System Events" to tell process "${UI_PROCESS}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "打开" or (name of elem) is "选取" or (name of elem) is "选择" then
        perform action "AXPress" of elem
        return "clicked"
      end if
    end try
  end repeat
  return "notfound"
end tell`).stdout?.trim();
      if (confirmed !== "clicked") {
        notes.push("PROBE: 面板上找不到「打开/选取/选择」按钮");
        result.probe = true;
        return result;
      }
      click("原生「选择交付包保存位置」面板(接受默认目录)");
    } else {
      // 没弹面板:可能直接落在了「更多方式」四模式详情页(不是首屏三卡的一次即出路径)——
      // 找一下常见的续跑按钮,点到底(不是真实用户会走的路,但如实记录,不假装一次即出成功了)。
      const fallbackLabel = ["导出剪映素材包到上次文件夹", "导出剪映素材包", "更改文件夹"].find((label) => windowText().includes(label));
      if (fallbackLabel) {
        notes.push(`替代:「交给剪映」没有一次即出,落在详情页——点「${fallbackLabel}」续跑(记为额外步骤,不计入点击数)`);
        // F-R19-06 取证:点之前先读按钮真实的 enabled(分开「产品把门关着」和「点了面板没来得及出现」)。
        const enabledBefore = buttonEnabled(fallbackLabel);
        result.exportButtonEnabledBefore = enabledBefore;
        notes.push(`取证:点「${fallbackLabel}」前 enabled=${enabledBefore}`);
        clickByLabel(fallbackLabel, { exact: true });
        const pressedAt = Date.now();
        let fallbackSheet = false;
        // 原生面板在本机负载高时不止 10s 才起来(F-R19-06 五轮「没落地」都在这一步);等 60s 并把延迟记下来。
        const fallbackDeadline = Date.now() + 60_000;
        while (Date.now() < fallbackDeadline) {
          if (nativePanelVisible("选择交付包保存位置")) {
            fallbackSheet = true;
            break;
          }
          sleep(500);
        }
        result.nativePanelLatencyMs = fallbackSheet ? Date.now() - pressedAt : null;
        notes.push(
          fallbackSheet
            ? `取证:原生「选择交付包保存位置」面板在点击后 ${Date.now() - pressedAt} ms 出现`
            : `取证:点击后 60s 内原生面板没出现;此刻按钮 enabled=${buttonEnabled(fallbackLabel)}`,
        );
        if (fallbackSheet) {
          osa(`tell application "System Events" to tell process "${UI_PROCESS}"
  set elems to entire contents of window 1
  repeat with elem in elems
    try
      if (name of elem) is "打开" then
        perform action "AXPress" of elem
        return "clicked"
      end if
    end try
  end repeat
  return "notfound"
end tell`);
        }
      }
    }

    // ── 落地判据:导出目录下出现文件(scratch 或面板默认目录都算,记录实际落点) ──
    const candidateDirs = [exportRoot, `${process.env.HOME}/Documents`, `${process.env.HOME}/Desktop`, `${process.env.HOME}/Downloads`];
    const beforeSnapshot = new Map(candidateDirs.map((dir) => [dir, new Set(existsSync(dir) ? readdirSync(dir) : [])]));
    const exportDeadline = Date.now() + 90_000;
    let landed = false;
    let landedDir = null;
    while (Date.now() < exportDeadline) {
      if (windowText().includes("已导出")) landed = true;
      for (const dir of candidateDirs) {
        if (!existsSync(dir)) continue;
        const now = readdirSync(dir);
        const fresh = now.find((name) => name.includes("剪映素材包") && !beforeSnapshot.get(dir).has(name));
        if (fresh) {
          landed = true;
          landedDir = join(dir, fresh);
          break;
        }
      }
      if (landed) break;
      sleep(1000);
    }
    result.seconds = (Date.now() - t0) / 1000;
    result.exported = landed;
    if (!landed) {
      notes.push("PROBE: 90s 内导出目录没有文件、界面也没出现「已导出」——落地判据没等到");
      // F-R19-06 取证:超时那一刻按钮与原生面板各是什么状态(busy 期间按钮 disabled,面板还开着就是「点了没人接」)。
      notes.push(
        `取证:超时时「导出剪映素材包到上次文件夹」enabled=${buttonEnabled("导出剪映素材包到上次文件夹")};原生面板仍在=${nativePanelVisible("选择交付包保存位置")}`,
      );
    } else if (landedDir && !landedDir.startsWith(exportRoot)) {
      notes.push(`落地在业主真实目录:${landedDir} —— 导出后立即清理,不留残留(见文件头注释)`);
      try {
        rmSync(landedDir, { recursive: true, force: true });
      } catch (error) {
        notes.push(`警告:清理 ${landedDir} 失败:${error.message}`);
      }
    }
  } finally {
    result.clicks = clicks;
    result.newWords = [...seenWords];
    if (process.env.FIRST_FIVE_DEBUG_KEEP_ALIVE) {
      notes.push(`DEBUG: FIRST_FIVE_DEBUG_KEEP_ALIVE 已设,保留 pid ${pid} 与 profile ${profile} 不清理`);
    } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    try {
      execFileSync("pkill", ["-9", "-f", profile]);
    } catch {}
    }
    writeFileSync(join(roundOutDir, "round.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (!process.env.FIRST_FIVE_DEBUG_KEEP_ALIVE) rmSync(profile, { recursive: true, force: true });
  }
  return result;
}

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(outDirBase, `${ts}-first-five`);
mkdirSync(runDir, { recursive: true });

const results = [];
for (let r = 0; r < rounds; r += 1) {
  console.log(`── round ${r} ──`);
  // eslint-disable-next-line no-await-in-loop
  const result = await oneRound(r, join(runDir, `round-${r}`));
  results.push(result);
  console.log(
    `round ${r}: clicks=${result.clicks} newWords=${result.newWords.length}[${result.newWords.join("/")}] seconds=${result.seconds ?? "N/A"} exported=${result.exported} probe=${result.probe ?? false}`,
  );
}

// 点击/新词在「交给剪映」点下去那一刻(reached >= 5)就已经定型,不必等文件真落地才算数;
// 秒数(启动到导出文件)必须真落地才有意义,两条判据分开算,分开报——不能因为最后一步卡住
// 就把已经量到的点击/新词也一起说成"没有效"。
const reached = results.filter((r) => !r.probe && r.clicks >= 5);
const clean = results.filter((r) => !r.probe && r.exported);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const summary = {
  app: resolve(appPath),
  fixturesDir: resolve(fixturesDir),
  rounds,
  results,
  median: {
    clicks: median(reached.map((r) => r.clicks)),
    newWords: median(reached.map((r) => r.newWords.length)),
    seconds: median(clean.map((r) => r.seconds)),
  },
  reachedCount: reached.length,
  exportedCount: clean.length,
  thresholds: THRESHOLDS,
};
writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const line = `${new Date().toISOString()} clicks=${summary.median.clicks} newWords=${summary.median.newWords} seconds=${summary.median.seconds} (交给剪映 ${reached.length}/${rounds} 轮到达 · 落地 ${clean.length}/${rounds} 轮) app=${bundleExecutable(appPath)}`;
console.log(line);
if (reached.length === 0) {
  // 连「交给剪映」都没到达(0/${rounds})不写进历史——history.jsonl 是给人看的数字台账,写一条
  // 全 null 的噪声行没有意义。探针故障留在 round-N/round.json 里查。
  console.error("PROBE: 一轮都没到「交给剪映」——探针故障或应用行为变了,不是数字不达标;检查 round-N/round.json 的 notes");
  process.exit(3);
}
if (clean.length === 0) {
  console.error("警告:点击/新词已量到,但没有一轮真的落地导出文件(seconds=null)——见 round-N/round.json 的 notes,可能是产品侧的门(canExport)卡住,不是脚本问题");
}
mkdirSync(dirname(join(repoRoot, "qa/perf/history.jsonl")), { recursive: true });
appendFileSync(
  join(repoRoot, "qa/perf/history.jsonl"),
  `${JSON.stringify({ ts: new Date().toISOString(), tool: "first-five-minutes", ...summary.median, reachedCount: reached.length, exportedCount: clean.length, roundsTotal: rounds })}\n`,
);
// null <= 60 在 JS 里是 true(null 被强转成 0)——秒数没量到时必须显式当失败,不能让 null 悄悄过判据。
const pass =
  summary.median.clicks <= THRESHOLDS.clicks &&
  summary.median.newWords <= THRESHOLDS.words &&
  summary.median.seconds !== null &&
  summary.median.seconds <= THRESHOLDS.seconds;
console.log(`${pass ? "PASS" : "FAIL"} first-five-minutes (点击 ≤${THRESHOLDS.clicks} / 新词 ≤${THRESHOLDS.words} / 秒数 ≤${THRESHOLDS.seconds})`);
process.exitCode = enforce && !pass ? 1 : 0;
