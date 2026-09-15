# 原生行为审计套件(`scripts/qa/native-audit/`)

R18 车道 native2 / M-12。回答一个 `npm run build` 永远回答不了的问题:
**这个包装到用户机器上之后,像不像一个 Mac 应用。**

菜单栏是不是中文、窗口会不会停在屏外、双击一个 mp4 能不能选到旅剪、
把文件夹拖到程序坞图标上会不会被接住——这几件事应用本身照样能跑,
六道门禁一条都看不见。

## 怎么跑

```sh
# 静态(不启动应用):只要一个 .app 就够
node scripts/qa/native-audit/run.mjs --app "dist/旅剪工作台.app"

# 带真机那一半:给一个活着的 pid(只读 AX 树,不 AXPress、不发按键)
node scripts/qa/native-audit/run.mjs --app "dist/旅剪工作台.app" --pid 12345

# 让套件自己起一个隔离实例(profile 默认建在系统临时目录)
node scripts/qa/native-audit/run.mjs --app "dist/旅剪工作台.app" --launch --profile /tmp/tripcut-audit

# 正控:同一套判定喂给旧包,必须报红
node scripts/qa/native-audit/run.mjs --app "新包.app" --control "/Applications/旅剪工作台.app"
```

退出码:`0` 全通过 / `1` 有缺陷 / `3` 探针故障。
**取真退出码**——别管道给 `tail`,那样拿到的是 `tail` 的退出码。

## 判什么

| 检查 | 需要 | 判定在 |
|---|---|---|
| `app.localization-and-file-access` | 只要 `.app` | `infoPlist.mjs` |
| `app.file-associations` | 只要 `.app` | `fileAssociations.mjs` |
| `app.window-on-screen` | pid + 辅助功能权限 | `fileAssociations.mjs` 的 `auditWindowOnScreen` |
| `app.menu-bar` | pid + 辅助功能权限 | `menuAudit.mjs` |
| `control.old-bundle-must-fail` | `--control <旧包>` | 上面两条静态判定 |

## 三条纪律

1. **取数与判定分开。** 抓 AX 树的是 `*.swift`,判定是 `*.mjs` 里的纯函数。
   纯函数先在 vitest 里对**旧包的实抓形态**报过红(`fileAssociations.test.mjs`、
   `menuAudit.test.mjs`),才敢信它的绿。
2. **抓不到 ≠ 有缺陷。** 没有辅助功能权限、pid 不对、窗口还没建起来、锁屏,
   一律 `PROBE`。2026-09-14 实测:锁屏时 `AXWindows` 里装的是**应用元素本身**
   (role=AXApplication),它的 `AXPosition` 一读就是 -25205;`axwindow.swift`
   因此先认 role,不认就报 PROBE——否则会被误读成"窗口跑到屏外去了"。
3. **只杀自己启动的 pid。** `--launch` 记下自己那一个;不给 `--launch` 时一个进程都不碰
   (`--pid` 只读不杀)。业主自己开着的那份永远不动。

## 权限

真机那一半要给**跑这个脚本的终端**「辅助功能」权限
(系统设置 › 隐私与安全性 › 辅助功能),不是给被测应用。
没给时 `AXUIElementCopyAttributeValue` 返回 -25204,套件报 `PROBE`。

## 2026-09-14 实测记录

对 `/Applications/旅剪工作台.app`(0.8.3,R18 之前的包)跑静态 + `--pid`:

```
FAIL app.localization-and-file-access   （CFBundleDevelopmentRegion=English、五条用途说明全缺、LSRequiresCarbon=true）
FAIL app.file-associations              （根本没有 CFBundleDocumentTypes）
PASS control.old-bundle-must-fail
PROBE app.window-on-screen              （锁屏,role=AXApplication）
FAIL app.menu-bar                       （Help / Undo / Redo / Cut / Copy / Paste / Select All / Services 全是英文,没有「设置…」「撤销」「帮助」）
真退出码=1
```

这一条同时是 R18 车道 native 那份报告里「菜单栏真的挂上了只有单测为证」的补充:
`menuAudit.mjs` 这次在**真机、真进程**上报出了 R18 之前那条英文菜单栏——
判定本身已经被证明会红。新包的绿还欠一次真机复跑(见下)。

## 还欠的

- 新包(0.9.0)的真机复跑:要先打 DMG(整套 LGPL 产物),且**屏幕不能是锁着的**。
- 退出确认(F2)与拖放(M-06①)的真机那一半:前者要先造一个在跑的后台任务,
  后者要真的从访达拖一次——两者都还没做成探针,验收时人工走。
