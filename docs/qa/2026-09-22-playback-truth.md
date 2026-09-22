# R23 播放真值车道 —— ISSUE-A / ISSUE-B 复现、根因与修复

- 交接报告:`旅剪播放与时间刻度问题-AI开发交接-2026-09-22.md`(业主,v0.11.3)
- 工作区:`~/Projects/tripcut-wt-r23-playback`,分支 `fix/r23-playback-truth`,基线 v0.11.3
- 引用的 `旅剪测试问题报告-2026-09-19.md` **在桌面上不存在**,本轮只能按交接报告本身的数字判。

---

## 1. 复现证据

复现装置:`src/workspace/playthrough/fakePlayer.ts` + `playbackTruth.test.tsx`。
不手喂状态 —— 自走播放器(播放中位置自己走、seek 异步落地、`player_open` 载入即播)
接**真** `useMonitorTransport`、**真** `usePlaythrough`、**真** `Scrubber`,按 80 ms
(= `PlayerOverlay.STATUS_INTERVAL_MS`)轮询采样。判「播了未选原片」用播放器真身的
位置,不用轮询读数(轮询滞后一拍,会把真相糊掉)。

### ISSUE-B —— 复现,数字与报告对得上

单素材两段 `[26.4,34.2] / [39.4,45.6]`,I/O 栏里是 AI 建议 `[5.0,13.0]`:

```
activeSegment = [26.4, 34.2]
monitorRange  = [4.2, 13.8]      ← 采样值
headPct       = 100%             ← 指针钉在右边缘
```

`4.2/13.8` = 建议段 `[5,13]` 各加 10% 余量(`scrubber/model.visibleRange`)。
报告 §4.2 那四行错误刻度 —— `5.0–13.0`、`14.5–22.5`、`64.5–72.5`、`171.5–179.5` ——
**宽度全是 8.0 s**,就是建议段的宽度。这条对得上,不是巧合。

### ISSUE-A —— 部分复现

- **跨素材**:复现。下一段在别的素材上时,新实例 `player_open` 之后载入即播,
  seek 到入点之前采到 `clipId=9, pos=0.08, paused=false` —— 放的是用户没选的原片
  开头。真机上 `player_open` 要几百毫秒,这一段是真的画面和声音(报告 §9 第一条)。
- **同素材两段的深坑(报告的 `35.12`)**:这套装置在理想条件下**复现不出来**。
  同素材 advance 的最大越界只有 0.04 s(一个轮询间隔),在 0.10 s 容差内。
  `seek` 晚 3 拍落地也照样正确。所以报告 §5「推测」里的
  「素材异步加载竞态」「旧 `currentTime` 写回」两条,在状态机这一层**证伪**。
- 但装置抓到了三条同形状的真缺陷(见 §2),每一条在真机上都会长出「原片一路往下播」:
  它们的共同形状是**出点只由前端轮询位置去追,播放器自己不知道 out 在哪**。

### 真 mpv 上的两条实测(mpv 0.41.0,60 s 测试片)

用的是 homebrew `mpv 0.41.0`;应用里链的 vendored libmpv 是
`~/Library/Caches/tripcut-build/native/mpv-lgpl/mpv` = **`v0.41.0`,同一个版本**
(`end` 在 `options/options.c:595` 是 `OPT_REL_TIME(play_end)`,裸数字按绝对时间解)。
所以下面这两条对应用里的播放器直接成立。

```
PROBE stopped_at=34.000 duration=60 eof=...   # end=34.2 + keep-open=yes → 停在 34,duration 不被截断
PROBE after_fence           pos=26.400
PROBE seek_past_stale_end   pos=34.160        # ← end=34.2 还挂着时 seek 39.4 被夹回 34.16
PROBE after_new_fence       pos=39.400
PROBE cleared end=none duration=60
```

第二条是**真机找出来、假播放器抓不到**的坑:围栏必须先撤再 seek。
装置随后按这个语义改了(`fakePlayer` 的 seek 也夹到 `endFence`),才守得住。

---

## 2. 根因(逐条「是 / 否 + 证据」)

| 报告 §5 的推测 | 结论 | 证据 |
| --- | --- | --- |
| `suggestedRange` 覆盖了已保存的 `activeSegment` | **是** | `Monitor.tsx` 建议一变就 `setInPoint/setOutPoint`;`Scrubber` 的 `visibleRange(duration, inPoint, outPoint, zoom)` 拿它算刻度。采样值 `[4.2,13.8]` 对上报告的 8 s 宽 |
| 素材异步加载 / `loadedmetadata` / `seeked` 竞态 | **否**(状态机层) | `seek` 晚 3 拍落地、`open` 晚 3 拍就绪,§8A/§8B 都仍然正确 |
| 旧素材 `currentTime` 在新段 seek 后写回 | **否** | 走带的 `anchor` + `readyStatus()` 已经挡住;装置里没采到一次回写 |
| 段索引与素材 / 边界非原子提交 | **是** | `enter()` 先 `publish({token, index, segments, …})` 再 `await pause()`。采样:`index=1, segIn=39.4` 而播放器还在 `pos=40.36` 上**播着**上一段 |
| UI 对越界 `currentTime` 做了 clamp,掩盖越界播放 | **是** | `scrubber/model.ratioAt` 末尾 `clamp(…, 0, 1)`;报告 §4.3 的推断成立 |
| 出点判定用了素材时长而非 `segment.out` | **否** | `usePlaythrough` 的 `atOut` 用的就是 `segment.outPoint` |
| 同素材下一段没有 seek、只顺序播 | **否** | `loading → seeking` 对同素材也发 `seek_abs`(`§8A` 断言 `seeks()` 含 `39.4`) |
| scrubber 的 range 取自 suggestions 而非 activeSegment | **是** | 同第一行 |

另外三条**报告没列、装置自己抓到**的:

- **R23-N1**:`useMonitorTransport.pause()` 要求 `readyStatus()`(状态里的 `clip_id`
  必须等于当前 clip)。换素材那一拍、监视器 `clips` 还没回来那一拍都不成立 ——
  `pause` 静默跳过,`stop()` 于是变成「状态机停了、原片还在播」。这就是报告
  §3.1 第二处证据(精选段 `[7.4,13.4]`、读数 `121.0` ≈ 片尾)最像的来源。
- **R23-N2**:`'frame'` 阶段发出去的 `play()` 若在切段的 `pause()` 之后才落地
  (两条异步命令不保序),令牌已作废却没人再按停 —— 上一段就自己往下跑。
- **R23-N3**:没有任何一层让**播放器自己**知道 out 在哪。前端状态机一旦掉链子
  (上面三条、10 s 超时、`releasePlaythrough`),原片就一路播到片尾。

---

## 3. 修了什么(按报告 §7 的七条)

| §7 | 改动 | 文件 |
| --- | --- | --- |
| 1 唯一真值 = 已保存 `selectedRanges` | 连播期间 AI 建议不再落进 I/O 栏 | `workspace/Monitor.tsx` |
| 2 `{index, clipId, in, out}` 原子提交 | `enter()` 先停旧源,**停住之后**才一次提交 `index + segments`;`token` 仍然立刻推进(迟到回调照样作废) | `playthrough/usePlaythrough.ts` |
| 3 切段先暂停 → 等就绪 → seek → 等首帧 → 再播 | 换素材时 `player_open(start_paused=true)`:新实例停在首帧,不再载入即播 | `player/mod.rs`、`lib.rs`、`api.ts`、`PlayerOverlay.tsx` |
| 4 到 out 只允许一次 advance | 新增 `PlayerCommand::SetEnd`(mpv `end` + `keep-open=yes`):**播放器自己**停在 out。开播前设,`seek` 前撤,连播停时撤 | `player/mod.rs`、`useMonitorTransport.ts`、`usePlaythrough.ts` |
| 5 同素材多段也必须 seek | 本来就有;§8A 现在有断言盯着(`seeks()` 必须含 `39.4`) | 测试 |
| 6 刻度 / 指针只从 `activeSegment` + 真 `currentTime` 派生 | 连播中 `range = [segment.in, segment.out]`(不加余量);切段中指针停在新段入点而不是画一个属于上一段的假位置 | `scrubber/Scrubber.tsx` |
| §9 业主拍板 | 连播释放(镜头带开始编辑)**不撤围栏**:素材播到 activeSegment.out 就停,按播放才自由播。释放后的人工 seek = 撤围栏 + seek + **暂停**(R23-N4 真机) | `usePlaythrough.ts`、`useMonitorTransport.ts` |
| 7 切段 token,忽略过期回调 | 已有 token;补上「play 赢了竞速但输了 token → 再 pause 一次」 | `usePlaythrough.ts` |

外加 §2 的三条:

- **R23-N1** → `pause()` / `setEnd()` 改成失败朝闭:只有「播放器根本不在」
  (`phase` 为 `closed` / `error`)才跳过。暂停跟位置无关,打在哪个实例上都是对的。
- **R23-N3** → 出点围栏(同 §7.4)。
- **越界不许被 clamp 遮**:`Scrubber` 在真位置落到活动选段外时挂
  `data-out-of-range`,§8C 盯它(报告 §8C 最后一条的硬要求)。

Rust 侧全是新增分支,现有分支一行没动;`SetEnd` 的非有限 / ≤0 值一律翻成
`end=none`(空播放窗口是最坏的失败朝开)。

---

## 4. 第 8 节逐条结果

全部做成自动化,文件 `src/workspace/playthrough/playbackTruth.test.tsx`(8 条,全绿)。

| 用例 | 判据 | 结果 |
| --- | --- | --- |
| **A** 单素材两段 | 播放中真位置不落入 `(34.2, 39.4)`;两段都播过;第二段真的 `seek_abs 39.4`;边界误差 ≤0.10 s;终态 `done` | PASS |
| **A** 出点围栏 | 每段开播前 `set_end`(`34.2` → `45.6`),连播停时 `set_end null` | PASS |
| **B** 跨素材 | 先换 `assetId` 并停在首帧;就绪后才 seek 到 `3.0`;新素材上没有一拍「在播 + 位置在入点前」;段号只走 `[0,1]`;`seek 3.0` 恰好一次 | PASS |
| **C** 刻度与指针 | `data-out-of-range` 一次都没亮;连播带每一拍 `left=0%`(= `monitorRange == activeSegment`);段内 `headPct` 单调不减,从 <5% 走到 >95% | PASS |
| **C** 暂停一致 | 暂停后 `pos` 与 `headPct` 都不动;继续后接着走 | PASS |
| **D** 手动上一 / 下一段 | 各自 seek 到自己的入点;全程不越界 | PASS |
| **D** 快速连续切段 | `next(); next()` 同一拍打两次;迟到回调不把播放头写回旧段;终态在第 3 段;不越界 | PASS |
| **D** 停连播真停住 | 走带 `clip_id` 对不上时 `stop()` 仍然发出 `pause`,播放器真的停 | PASS |

**探测器已校准**(不是「一写就绿」):把 `Scrubber.tsx`、`usePlaythrough.ts`、
`useMonitorTransport.ts` 三份签回 v0.11.3 原文、并把换素材改回载入即播之后,
**8 条里 5 条变红**(§8A 围栏、§8B 跨素材、§8C 刻度、§8D 快速切段、§8D 停连播)。
`fakePlayer` 补上「seek 被 stale `end` 夹住」的真 mpv 语义时,又有 3 条先红后绿。

自动连播、暂停后继续、同素材多段、不同素材相邻段都在上表里。
Rust 侧 `set_end` 的契约与夹紧有 `player::tests::set_end_fences_playback_at_the_out_point_and_none_clears_it`。

---

## 5. 门禁

`node scripts/qa/fast-gates.mjs`:typescript / eslint / vite-build / check-chunks /
vitest / cargo-build / cargo-test / cargo-clippy(`-D warnings`)/ cargo-audit /
npm-audit / preview-diff-dark **全 PASS**。
`vitest` 全量 **263 文件 1801 通过 / 0 失败**。

唯一 FAIL 是 `perf-bench-100`:本 worktree 缺
`spikes/s2-libmpv/media/test-4k-hevc-10bit.mp4`(LFS 媒体),夹具生成失败。
门禁自己把它标成「基建问题,不是阈值判定」,与本轮改动无关。

---

## 6. 应用内真机走查(QA 包 `r23-qa-bd7b6a1`)

装置:QA 包 ad-hoc 签名(`audit-dmg --expect-signature adhoc` **13 PASS / 0 FAIL**),
隔离 profile `TRIPCUT_APP_SUPPORT_DIR=/tmp/r23-native/profile` +
`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/` + `TRIPCUT_LOG=debug`,按 pid 激活(不 `open -a` 起应用),
开跑前 `screencapture -x` 确认是桌面。夹具两条 25 fps 合成片(clipA 60 s / clipB 50 s)。
镜头带形状全部走应用自己的流程造出来(建议段 → 保存片段 → 一键排入),没有改过库:

```
clipA: [4.5, 12.5] 与 [46.5, 54.5]   未选区间 G = (12.5, 46.5)
clipB: [2.5, 10.5]                    跨素材相邻段
```

判据取两处:Rust 侧 `player command` 调试日志(命令序列的权威),
以及 AX 轮询 `slider "播放位置"` 的 `value`(界面上的真实播放位置)。

### ① 同素材两段:不进未选区间,各自真 seek —— PASS

镜头带只留两个 clipA 镜块时(第 2 个镜块用「移出所选」拿掉 clipB 那条),命令序列:

```
Pause → SetEnd{None} → SeekAbs{4.5}  → SetEnd{Some(12.5)} → Play
Pause → SetEnd{None} → SeekAbs{46.5} → SetEnd{Some(54.5)} → Play
        SetEnd{None} → Pause → SeekAbs{54.46}
```

下一段是**真 seek 46.5**,不是顺着原片放过间隔。位置采样(147 条):
第 1/2 段 n=43 min=4.50 max=12.36;第 2/2 段 n=42 min=46.50 max=54.36;
**越界 0 条,落进 (12.5, 46.5) 的 0 条**,段内单调不回头。

### ② 跨素材:先停在首帧再 seek —— PASS

三镜序列(clipA → clipB → clipA)的跨素材那一跳:

```
SetEnd{None} clip=2 → Pause clip=2 → SeekAbs{2.5} → SetEnd{Some(10.5)} → Play
```

新实例没有一条 `Play` 早于 `SeekAbs`;位置采样第 2/3 段 min=**2.50**,
**入点 2.5 之前 0 条**。旧版本这里是 `pos=0.08、paused=false`(复现装置里量到的)。

### ③ monitorRange == activeSegment、指针连续 —— PASS

每一段的位置采样都从该段入点起、到出点止,单调不回头
(4.50→12.36、2.50→10.44、46.50→54.36),没有一拍停在刻度边缘;
进度条上「第 n/m 段」与正在播的段一致。刻度范围等于选段这一条的 DOM 级断言在
§4 的 §8C 自动化里(连播带每一拍 `left=0%`)。

### ④ 释放连播停在 out、不自动开播 —— PASS(业主拍板的新口径)

拖动镜块(= 开始编辑镜头带 → `releasePlaythrough()`)后,素材继续播,
**停在活动选段的 out**(实测 54.48 ≈ 54.5),并在那里静止 12 s 不动;
按「播放」之后才越过 out 继续(54.96)。

修 R23-N4 之前的同一条路子上,实测是从 51.0 一路播到片尾 **59.96** —— 见 §7 P2 之前那一条。

---

## 7. 未覆盖 / 未做 / 留下轮(P2)

1. **真机走查只做了核心四条(§6),没有把报告 §3.3 的六个镜头逐个走一遍。**
   用的是合成夹具(两条 25 fps 测试片),不是业主那批素材,段值也不是报告里的
   26.4/34.2/39.4/45.6 —— 形状等价(同素材两段不连续 + 跨素材相邻段),数字不同。
2. ~~`releasePlaythrough()` 保持原样~~ —— **业主已拍板改掉**(§3 表 + §6 ④):释放后播到 out 就停。
   它是 0.11.3 明写的设计(「与拖进度条同语义」),但它确实会让原片越过 out
   一路往下播 —— 与报告 §9 第一条「连续播放期间没有任何未选帧或未选音频」冲突。
   本轮的选择是:连播一停就撤围栏,把它当成普通的素材自由播。
   **要不要改成「释放时也停在 out」,是业主的口径,不是缺陷。**
3. 报告 §3.1 第二处证据(`[7.4,13.4]` → `121.0`)最像 R23-N1 + R23-N3 合起来的产物,
   本轮把两条都堵了,但**没有拿到那一次的现场日志**,不能说已经定案。
4. 报告 §6 建议的结构化日志没有单独加一套 —— 采样与判定都落在测试装置里
   (`fakePlayer.samples` + `playbackTruth` 的 `Sample`),真机排障时还是得靠
   `TRIPCUT_LOG=debug` 下 `lib.rs` 已有的逐条播放器命令日志。要真机可观测的话,
   这是下一件事。

### 留下轮(P2,本轮不修)

- **P2-1 释放后在进度条上拖/点,会被手势自己的「松手恢复播放」重新开播。**
  `Scrubber` 的拖动手势按下时 `onPause`、松手时 `onResume`;释放连播之后做一次
  进度条 seek,走带的「seek 完暂停」确实发了(日志 `SetEnd{None} → SeekAbs{48.0} → Pause`),
  紧接着手势的 `onResume` 又发了 `Play`,素材从落点自由播到片尾。围栏已按人工 seek 的
  语义撤掉,判定上算「用户自己在驾驶」,但与 §9「释放后要按播放才继续」不完全一致。
- **P2-2 AX 读数在切段那一瞬会把「新段号」和「上一段位置」配到一起**(131 条里 1 条,177 ms 窗口)。
  配到的位置本身仍在它自己那段的合法范围内(12.44 ≤ out 12.5),下一拍就是新段入点;
  Rust 侧命令日志显示切段是干净的。是 AX 两个对象各自更新造成的读取偏斜,不是应用状态不一致。
- **P2-3 `vitest` 会把 `src-tauri/target` 下 public-sync 的旧副本当测试收进来。**
  把 worktree 的 `src-tauri/target` 符号链接到共享 target 去打包时撞到(多出 9 个红文件)。
  `vite.config.ts` 的 test include 没有排除 `src-tauri/target`。本轮靠打包完就把符号链接删掉绕开。
