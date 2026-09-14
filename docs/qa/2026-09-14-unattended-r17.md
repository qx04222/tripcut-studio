# 无人值守 R17 · 软件内自动更新(0.8.1)

业主诉求(2026-09-14):「能否规划软件内自动升级的功能?现在每一次需要重新下载升级」「希望默认开启自动更新」。

## 1. 根因(为什么之前"每次都要重新下载")

更新机制(Tauri updater + minisign 签名 + GitHub `latest.json`)从 0.3.0 起就是通的;问题在(a)只有手动点「检查更新」才查,(b)业主桌面上装的多是本机测试包,版本号高于 GitHub 上的正式版,点了也只会显示「已是最新」。0.8.0 把正式版发到 GitHub,0.8.1 补上自动检查与后台下载。

## 2. 交付

- 车道 A(Rust,`f57e37d`):`update_flow.rs` —— `check_for_update` / `download_update` / `download_and_install` / `install_staged_update` / `restart_to_update` / `get_auto_update_plan` / `get_update_status`;进度事件 `tripcut:update-progress`;替换在 `RunEvent::Exit` 完成;`TRIPCUT_UPDATER_SELFTEST=1` 无头自测。
- 车道 B(前端,`ac30866`):`src/workspace/update/*`,设置 › 关于 › 应用更新;Toast 套件加 `actions` / `sticky`。
- 接线(`d520044` 前一提交):前端 `UpdateCheckResult` 与 Rust `UpdateCheck` 对齐(`current_version` / `offline` / `skipped`),离线静默不再当作「已是最新」。
- 设置键:`updater.auto_update`(默认 **true**)、`updater.ask_before_download`(false)、`updater.last_check`、`updater.skipped_version`。
- 门禁:`qa/runs/2026-09-14T19-36-52Z-fast-gates` PASS。
- 发布:v0.8.1(23 资产,`latest.json → 0.8.1`,DMG SHA-256 `126c7151…6842`),公开仓已同步(含补 0.8.0 的说明)。

## 3. 真机实验室(锁屏期间做的无头路径)

环境:0.8.1 发布包解包到 scratch,`TRIPCUT_APP_SUPPORT_DIR` 独立 profile,`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:8765/latest.json`(loopback 喂 0.8.1 的签名 tar,`version` 改成 0.8.2),`TRIPCUT_UPDATER_SELFTEST=1`。

| 用例 | 结果 |
|---|---|
| 正常路径:检查 → 后台下载 → 验签 → 暂存 → 退出替换 | stderr `update selftest: staged 0.8.2; exiting`,exit 0;http 日志 `GET /latest.json` + `GET /update.app.tar.gz`;`.app` 与 `Contents` 目录 mtime 变为退出时刻 15:53:36(退出钩子已重写 bundle) |
| 篡改包(tar 尾部追加 1 字节) | `update selftest: FAILED: 更新包签名校验失败,已拒绝安装。可以手动下载最新版:…(详情:The signature verification failed)`;bundle 未动 |

未做(锁屏阻塞 AX):0.8.0 真机点「检查更新」升到 0.8.1 的 UI 路径、0.8.1 的 toast「更新已下载 · 重启完成更新」与状态条「正在下载更新 n%」的截图;0.8.0 没有 selftest 钩子,只能靠 UI。`scripts/qa/preview-shots.mjs` 32/33 两张是 jsdom 层面的证据。

## 4. 给业主

- 0.8.0 用户:设置 › 关于 点一次「检查更新」升到 0.8.1(或等 0.8.0 自己的手动路径);之后自动。
- 0.8.1 起:启动 30 s 后查一次、每天最多一次;后台下载不打断;只弹一次「重启完成更新」。不想自动可在 设置 › 关于 关掉。

## 5. 解锁后真机补验(16:40–17:00)

| 项 | 结果 |
|---|---|
| 0.8.0 → 0.8.1 UI 路径(0.8.0 发布包 + loopback 0.8.1 feed) | 设置 › 关于 › 「检查更新」→ 出现「下载并安装」→ 按下:http 日志 `GET /update.app.tar.gz`,bundle `Contents` mtime = 16:42:31,`Info.plist` 版本变 0.8.1,旧进程自行退出。**通**。 |
| 更新后首启 | 高负载(两条车道 cargo/vitest 同跑)下 5 次启动:12 s 时 2 次正常 / 3 次白屏或只有 1–3 个 AX 元素,27 s 后全部正常;同一 bundle 换新 profile 12 s 即正常。1 次进程在 12 s 内自行退出(无崩溃报告,stderr 空)。归入 X-06 冷启动待查;不是更新机制的问题。 |
| A16-03 镜块「···」菜单(合并后 QA 构建 `aeabaa4`+) | 真鼠标点镜块「更多」:menu「镜块操作」AX 几何 (948,804) 160×141,在窗口内、指针旁、向上翻开(截图 `menu-band2.png`)。**通**。 |
| 业主报的播放起点问题 | 同一次截图复现:只点选镜块 IMG_0831,监视器显示 `00:04.0 / 00:08.1`(上一条停在 4.0 s)。已开车道 playfix。 |
