# E-06 A18-01「首启 7 分钟无响应」取证(R19 perf 车道续,2026-09-18)

不是修复,是取证——按 `brainstorm-perf-eng.md` §5 E-06 的排查方案执行。

## 复现条件

`qa/perf/a18-01/make-reorder-profile.mjs` 直接写 sqlite `clips`/`jobs` 两张表
(不需要真实素材文件),构造「27 条素材 × 4 类任务(`full_hash` /
`analyze_l1` / `analyze_motion` / `thumbnail`)= 108 条 pending job」的库,
放进隔离 `TRIPCUT_APP_SUPPORT_DIR` profile,起真实 release `.app`
(`v0.10.0-preview` DMG 里的 `旅剪工作台.app`,与本分支 E-01/E-07/P-10 代码无关——
纯排查,不带来本轮改动的干扰)。**本机没有并行车道在跑**(先排除 R18 报告怀疑的
条件 3:资源竞争)。

## 六轮真机结果

| 轮 | rust_setup_ms | startup backfill elapsed_ms | first_paint_ms | 备注 |
|---|---|---|---|---|
| round1 | 414 | 61 | 792 | 快 |
| round2 | 211 | 279 | 观察窗 20s 内未出现 | 见下 |
| round3 | 203 | 19 | 观察窗 30s 内未出现 | 见下 |
| round4 | 307 | 137 | 观察窗 15s 内未出现;lldb attach 主进程后仍未见 | WebContent 子进程持续 **0.0% CPU**(与 A18-01 原始症状描述一致) |
| round5 | 235 | 13 | **41 388**(41.4 s) | 无上限等待才等到;这段时间主进程 CPU ≈8.6%,不是 0%,但明显比 round1/6 慢两个数量级 |
| round6 | 328 | 42 | 649 | 快 |

`rust_setup_ms`(203–414ms)与 `startup backfill elapsed_ms`(13–279ms)六轮都很快、方差不大——
**Rust 侧(拿锁、扫库、108 条 job 入队)不是瓶颈**,这与 R18 报告"WebContent CPU 0% 却无响应"
的观察吻合:卡点不在 Rust 计算,而在窗口起来之后到首帧之间那一段。

`first_paint_ms` 六轮里三快(649–792ms)、一慢(41 388ms)、两轮观察窗内彻底没等到
(round2/3,分别等了 20s/30s——不排除它们其实也需要类似 round5 的 30–40s 才会到,
只是我等的时间不够长就杀掉了)。**这本身就是数字**:同一份夹具、同一个二进制、
同一台没有其他车道在跑的机器,`first_paint_ms` 从 649ms 到 41 388ms 跨了近 64 倍,
证明「27×4 重排」这个形状确实会间歇性地让首帧显著变慢——量级上小于 R18 报告的 7 分钟,
但方向一致,而且不是偶发一次,六轮里出现了三次「明显慢或等不到」。

## 卡在哪一段:只做到「排除 Rust 侧」这一步

- `round4-main-thread-backtrace.txt`:round4 卡住期间对主进程 `lldb -p <pid> -o "thread
  backtrace all"` 打的全线程栈——主线程在 `mach_msg2_trap`(AppKit `-[NSApplication run]`
  事件循环里等消息),其余线程(`graceful-signals`、`NSEventThread`、
  `JavaScriptCore libpas scavenger` 等)都在正常等待,**没有一条线程卡在锁或忙等**。
  这排除了「Rust 侧某条 Tauri command 拿着 `LIBRARY_REGISTRY_LOCK`/`import_gate`/
  `control.with_maintenance` 长时间不放」这个头号猜测(brainstorm §5 可能根因 1)——
  至少这次 round4 的卡不是这个原因。
- `round4-webcontent-attach-denied.txt`:对 WebContent 子进程(`com.apple.WebKit.
  WebContent.xpc`)`lldb -p <pid>` 直接被拒绝——`attach failed (Not allowed to attach
  to process)`,这是 WebKit XPC 服务的沙盒限制,本机没有关闭 SIP / 没有额外的调试
  entitlement,拿不到它的线程栈。**卡点很可能就在 WebContent 内部(渲染进程冷启动 /
  JS 引擎初始化 / 与主进程的 IPC 往返),但本轮工具权限够不到那一层**,这是本次取证
  没有回答的问题,不是排查方案本身的缺陷。

## 结论(排查方案产出的判断,不是修复)

1. **条件 3(资源竞争)不是必要条件**——本机没有并行车道在跑,依然复现了「首帧明显
   变慢」(round5:41.4s)。
2. **Rust 侧持锁(可能根因 1)本轮排除**:round4 的主进程全线程栈干净,没有忙等/持锁
   证据;`rust_setup_ms`/`backfill elapsed_ms` 六轮都在几百毫秒内。
3. **13 步 `enqueue_missing_*` 全表扫本轮也基本排除**(可能根因 2 的"阻塞入队本身"
   那一半):`backfill elapsed_ms` 最高只有 279ms,远达不到分钟级。
4. 卡点方向指向 **WebContent 渲染进程冷启动 / 前端与后端首次握手** 这一段
   (`first_paint_ms` 之前),但本轮工具权限拿不到 WebContent 的线程栈,**没有实锤**。
5. 首帧耗时六轮里三次 <1s、一次 41.4s、两次超过 20–30s 观察窗——**间歇性**这一点
   与 R18 原始报告的「同构建同 profile 再启两次分别 24s/12s」是同一种现象的更极端版本。

## 留给下一轮的具体下手点

- 拿到能 attach WebContent 的权限(关闭 SIP,或给 lldb 加 `com.apple.security.
  cs.debugger` entitlement 并重签),对慢的那一轮直接打 WebContent 的线程栈——
  这是唯一还没做到、但工具链上可行的下一步。
- 或者换一个不需要 attach 的角度:在前端 `main.tsx` 的 `ReactDOM.createRoot().
  render()` 调用前后各插一个 `performance.mark`,配合 Safari Web Inspector(通过
  `WebKitWebInspector`/远程调试)连上这个 WebContent 目标看它自己的时间线——不需要
  lldb attach 权限。
- `qa/perf/a18-01/make-reorder-profile.mjs` 已入库,是长期回归探针:下次怀疑
  A18-01 复现,直接对一个已起过一次的空库跑这个脚本,起 .app 若干轮记
  `first_paint_ms` 方差,不用再现造夹具。
