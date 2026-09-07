# TripCut v0.1.1 素材库、导入恢复与发布验收

日期：2026-09-04。工作目录：`/Users/xin/Projects/tripcut-studio`。

## 结果与范围

本轮落实素材库新建/切换/移除列表/恢复、导入批次停止和撤销、选中移除、清空当前集、重复提示清理，并合入上一轮高清分析、界面和任务稳定性优化。原视频不删除；“从列表移除”保留完整库，能够恢复。“清空”与“撤销”修改当前集的索引和关联结果，执行前有影响预览与数据库快照。当前库要先切换到其他库再从列表移除。

库注册表使用进程内及进程间锁、原子保存。已注册库丢失数据库时明确报错，防止生成空库。切换在后台任务维护锁和导入锁持续持有期间重启。运行中任务先结束，尚未开始的任务留在旧库，返回后继续。

批次取消覆盖已关联素材的派生分析；部分扫描失败会终止已入队任务。取消、失败、撤销后允许重新选择相同文件夹。并行内容核验、扫描代次和单调素材 ID 防止重复提交、旧扫描复活或缓存错配。自动同步新目录默认关闭，取消/移除会暂停相关目录同步；封存集和未完成交付受保护。

## 验证证据

- 前端：公开源码副本最终运行 17 个文件、104 个测试全部通过；ESLint 通过。`src-tauri/target/library-qa/public-tests-final.log`、`public-lint-final.log`。
- Rust：400 单元 + 7 artifact + 5 fixture = 412 通过；1 项目标设备性能测试忽略。最终重启锁修正后 Clippy 通过，最终打包完成 Rust 编译与 TypeScript/Vite 构建。`rust-full.log`、`clippy-final.log`、`package-r3.log`。完整 Rust 套件位于最后重启调用位置修正之前，该修正另以最终 DMG 双向切库验证。
- 导入/移除回归包括：活动任务取消的提交保护、部分扫描中断、旧素材关联任务取消、重复/大文件指纹碰撞、并行相同素材、撤销后重导、外键完整性、封存集与交付保护。
- 最终候选 r3 DMG，隔离 `TRIPCUT_APP_SUPPORT_DIR`：重导三条 H264/4K HEVC 8-bit/4K HEVC 10-bit 测试素材；质量/运镜全部完成；勾选移除一条后剩两条；B→A 零素材；从列表移除 B 并恢复；A→B 两条保留；4K HEVC 10-bit 原片实际播放到 20.1 秒，暂停/返回正常，正常退出。
- 相同后端代码的 r1 候选：重复导入三条全部跳过；撤销预览取消不改变记录，确认后 3→0；再次导入恢复三条。UI 点击“停止本批”时任务已完成，因此不把该点击作为运行中取消的原生验收。运行中取消由 Rust 回归测试覆盖。
- 最终隔离库 `integrity_check=ok`、`foreign_key_check=[]`；源目录三个视频均仍存在；最近一小时未发现 tripcut 崩溃报告。`native-final-result.json`。该结果不等于长期 soak 或干净电脑证明。
- 最终 DMG 审计 PASS：签名完整性、ad-hoc 类型、25 个 Mach-O 许可证据、来源哈希、无外部非系统依赖/禁用 runtime、实际 bundled H264 VideoToolbox 编码。`release-prepare-final.log` 与发布附件 `DMG_AUDIT_REPORT.json`。
- 公开源码归档 Gitleaks 无发现。对包含本地构建目录的额外扫描匹配一个被排除的 Rust `.rmeta` 二进制位置；公开归档扫描独立通过，该编译元数据不在源码或发布附件中。

## 产物与开源同步

公开仓库：https://github.com/qx04222/tripcut-studio

公开提交：`fca8c77552bf39162964a66f8e4e5f4801bd2be9`。

已发布：https://github.com/qx04222/tripcut-studio/releases/tag/v0.1.1

GitHub 回读验收：19 个附件均为 uploaded，附件名称/大小与本地产物一致；DMG 的服务端 SHA-256 与本地一致；main 和 v0.1.1 标签均指向上述提交。证据：`src-tauri/target/library-qa/github-release-verified.json`。

DMG：`TripCut-Studio_0.1.1_v0.1.1-preview-r3_preview_aarch64.dmg`。

SHA-256：`12e2a8db84cffa2abfd268d5a2481f69bea5e74b7211b1f4896fadbc97cd0b21`。

公开副本位于 `src-tauri/target/public-v0.1.1`，基于公开 main 原历史，只同步 31 个明确产品/版本/文档文件。未推送私有仓库历史、内部 QA 文件或数据库。公开副本与内部产品允许列表逐文件比对一致；公开 README 自有内容保留。发布材料包括应用与第三方源码、补丁、构建脚本、许可证、来源清单和 SHA256SUMS。

## 验收边界与本地意外恢复

这是 Apple Silicon arm64 的未公证预览版，不是 Developer ID 签名商业正式版。schema 升级至 29，使用旧应用前必须恢复升级前快照。没有更换应用内 AI 模型；真实模型长时间运行、M2/16GB、NAS 大库和干净机器尚未验收。上一轮运镜内存基准是独立计算场景，不代表整机应用总内存或全流程倍速。缓存目录删除失败时保留磁盘残留并记录警告，尚无持久清理队列。

r1 退出后，UI 工具的一次读取自动重新启动应用且未继承隔离环境，使默认旧库自动从 schema 26 升级至 29。立即停止该实例，未操作其素材。与迁移前快照逐条对比 clips/segments/ratings/exports 的旧字段和记录，完全一致；在离线独占锁内用快照恢复 schema 26 并验证 integrity=ok。升级后副本与升级前快照均保留作为本地证据，不公开。已向用户说明。本次后续原生验收均使用隔离库，退出后只用进程检查，不再调用会自动启动的 UI 读取。
