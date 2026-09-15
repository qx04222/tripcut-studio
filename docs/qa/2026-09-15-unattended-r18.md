# 无人值守 R18 · 专业级打磨(设置 · 视觉 · 性能 · AI)

规格:`docs/superpowers/specs/2026-09-14-r18-polish-perf-ai-design.md`;头脑风暴与车道报告在 `.superpowers/sdd/r18/`(不入库)。

## 1. Wave 1 合入(main,门禁全 PASS)

| 车道 | 合入 | 要点 |
|---|---|---|
| tokens | `bad173b` | 样式门禁扩到 43 个车道 CSS(扩围前红 89 处:字号 12 / 圆角 40 / 阴影 17 / transition 3 / z-index 17),新令牌只加不改,深色 `--ring` 内圈不透明,`preview:shots` 加 @2x |
| icons | `372588d` | 图标规范 + 几何门禁(修前 533 个坐标越四分格、15 处点径不合规 → 0),39 枚重画,新增 tag/similar/takes/slot,应用图标 squircle:包围盒 962×953 → 824×824(Apple 网格合格),icns 2.0 MB → 148 KB |
| native | `65cce73` | 中文原生菜单栏 + ⌘Z(原生 Edit 菜单曾吞键)、窗口几何钳制 + 全屏态不写回、关窗时后台任务确认、`CFBundleDevelopmentRegion=zh-Hans` + 五条 UsageDescription、权限被拒引导、release strip+thin LTO:二进制 41.8 → 26.5 MB(−36.7%) |
| aiground | `ccfbdda` | `qa/ai-eval/` 21 条真素材真值入库 + 基线(OCR 关键词召回 2/18、口播负控 3/7、最佳窗 IoU≥0.5 7/18;八维/搜索未测量——本机无 CLIP 模型)、本地一句话描述 `clip_brief`(迁移 0045)、云端描述 prompt 接地(subject=食物 断言先红后绿) |
| settings | `7361523` | 通知开关 ×2、工具路径「恢复内置」、「清空全部失败」(走新 `clear_failed_jobs`,`request_cancel` 对 blocked 无效)、「更改缓存位置…」(搬迁事务,需重启)、按天自动清理(默认从不)、`tracing` 真落盘(每日轮转 7 天,写前脱敏且断言替换发生)、「导出诊断包…」zip(整包 grep 绝对路径 0 命中) |
| layout | `1434c58` | 顶栏 <1440 折叠成「第 ④ 步 · 导出 ⌄」胶囊、更新就绪降 ghost(同一时刻只一颗实心主按钮的断言)、媒体池去框外搜索钮/芯片一行/卡片定高/列数两档、监视器井充满 + toast 栏底、镜头带工具条三组 + segmented、首页一套卡片、状态条三组、1280 检查器折叠条横排 |
| perf | 进行中 | 见 §3 |

接线修补:`native-r18.css` z-index 令牌、`settings-r18.css` 字号令牌、`api.ts` 合并丢括号、菜单审计探针跳过系统 Apple 菜单并接受「设置…」。

## 2. 真机验收(r18-qa-675e7d8 构建,隔离 profile,walk8 27 条)

| 项 | 结果 |
|---|---|
| Info.plist | `CFBundleDevelopmentRegion=zh-Hans`、`NSDesktopFolderUsageDescription` 中文白话 ✅;二进制 25.1 MB ✅ |
| 菜单栏审计(`scripts/qa/native-audit/menu-audit.mjs --pid`) | PASS:旅剪工作台(关于 / 检查更新… / 设置… ⌘,)· 文件(导入素材 ⌘I / 导出 ⌘E)· 编辑(撤销 ⌘Z / 重做 ⇧⌘Z …)· 显示(命令面板 ⌘K / 全屏)· 窗口 · 帮助(使用手册 / 快捷键表)✅ |
| 窗口钳制 | `window.x=5000` 启动 → 窗口在 (144,88) ✅(两次) |
| ⌘Z | ⇧多选 8 张按 X → 8 条 -1;⌘Z → 最新评级无 -1,收藏回到 19、未评 1、星级回写 8 ✅(一次撤销,无双触发) |
| 退出确认 | 「清理缓存并重新分析」后点红点 → 卡「还有 4 个后台任务没做完,现在退出会中断它们 / 继续等 · 仍要退出」✅;后台空闲时点红点直接退出、无 `.unclean-exit` ✅ |
| 设置 › 关于 | 自动更新开关、检查更新、重置引导、复制诊断信息 / 导出诊断包… / 打开日志目录 ✅;新图标(桶 / 键帽 / 半圆 / 仪表 / 工具箱 / 问号)16 px 清晰 ✅ |
| 设置 › 项目与缓存 | 缓存位置 · 更改缓存位置… / 多久没用就自动清掉(从不) ✅;工具与模型三个「恢复内置」✅ |
| 1280 宽 | 流水线折叠成「第 ④ 步 · 导出 ⌄」胶囊、检查器折叠条「› 检查器」横排 ✅ |
| 日志落盘 | `logs/tripcut.log.2026-09-15` INFO,路径已脱敏(`<路径>`)✅ |

发现:
- **A18-01(一次,未复现)** 第一次启动(profile 从 0.8.x 复制,启动时 4 类任务 ×27 重排,机器 load 30+)媒体池「正在整理素材」约 7 分钟才出卡,期间点设置无响应,WebContent CPU 0%;同构建同 profile 再启两次分别 24 s / 12 s(含 x=5000 钳制)。留观:下次出现先抓 `logs/` 与 WebContent 采样。
- 关于页「自动更新」说明文案在 1512 宽下换行到开关下方(轻微)。
- 未做:诊断包保存面板(原生 NSSavePanel,AX 难驱动;单测已证 zip 无绝对路径)、VoiceOver 走查、深色主题走查、M-Pro/Max 与 8 GB 真机。
