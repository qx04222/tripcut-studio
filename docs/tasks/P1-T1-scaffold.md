# 任务卡 P1-T1:工程脚手架与数据层地基

状态:进行中(2026-08-31 派发)。实施:Codex。主审/验收:Claude。变更记录见文末。

## 1. ID/阶段/依赖与前置结论
P1-T1。阶段 P1(MVP 闭环)第一卡。前置:规格 v4 已定稿(`docs/specs/2026-08-31-tripcut-design.md`);P0 结论已出:S2 libmpv 可行(播放器**不在本卡**)、S3 拍板 PyTorch-MPS(AI 层不在本卡)、E0 原生草稿路线保留(交付层不在本卡)。无未满足前置。

## 2. 用户可观察目标
在本仓库执行 `npm install && npm run tauri dev`,弹出名为「旅剪工作台」的原生窗口,左侧三项导航(导入/筛片/交付,内容为占位页);同时后台已建好 SQLite 项目库与任务队列骨架,`cargo test` 全绿证明数据层行为正确。

## 3. 范围与非目标
**做**:
- Tauri 2 + React 19 + TypeScript + Vite 脚手架(目录:`src-tauri/` Rust,`src/` 前端),**深浅色自适应**基础壳(颜色全走 CSS variables token,`prefers-color-scheme` 跟随系统,浅深各一套完整定义,不硬编码颜色),三视图路由占位
- Rust 侧 `core` 模块:rusqlite 打开/初始化 `project.db`(WAL),**schema v1**(见 §6)+ `schema_version` 表 + 顺序迁移框架(编号 SQL 常量数组,启动时逐条应用,失败即拒绝启动并报错)
- 任务队列:`jobs` 表 + tokio 后台 runner 骨架:领取 pending→running,attempt_id 自增,产物路径约定「先写 `<final>.tmp-<attempt>` 再原子 rename + 落 `finished_at`」;进程重启时 running→pending;指数退避字段(attempt 计数,≥3 标 blocked 并写 blocked_summary)。本卡只需一个内置 `noop` 任务类型驱动测试,真实任务类型后续卡注册
- axum loopback:随机端口 + 启动时生成随机 token(仅存内存),`GET /cache/*` 从缓存目录取文件,无/错 token → 401,路径穿越(`..`)→ 400;端口与 token 经 Tauri command 暴露给前端
- 门禁脚手架:`cargo test`(含迁移测试+队列状态机测试+axum 鉴权测试)、`npm run typecheck`(tsc --noEmit)、eslint、vitest(最少 1 个冒烟测试)全部可运行
**不做(非目标)**:播放器/libmpv、ffmpeg、任何 AI 分析、真实导入逻辑、缩略图、UI 具体交互、打包签名、GitHub Actions。不引入 Python。不改 `docs/`、`spikes/` 下任何文件。

## 4. 承重假设与杀停条件
- 假设 Tauri 2 当前稳定版在 macOS 26/Apple M5 上 `tauri dev` 可用。若脚手架本身在本机跑不起来(工具链/兼容问题),**杀停**:不要绕道换 Electron/换框架,写明卡点报告回来。
- 假设 rusqlite(bundled SQLite)可用。若 bundled 特性编译失败,允许改用系统 SQLite,记录在交付证据。

## 5. 接口与数据契约
- Tauri commands(本卡最小集):`get_media_server_info() -> { port: u16, token: String }`;`get_app_info() -> { version, db_schema_version }`。命名蛇形,返回 serde JSON。
- axum:`GET /cache/{path}` header `Authorization: Bearer <token>`(或 query `?t=`,二选一实现并写进 README)。
- 错误码约定:Tauri command 错误一律 `Result<T, String>`(本卡),后续卡换 typed error。

## 6. 数据不变量与迁移
schema v1(migration 0001,字段可按实现微调但下列不变量必须成立):
- `schema_version(version INTEGER)` 单行
- `volumes(uuid TEXT PK, label TEXT, fs_type TEXT, last_seen_at TEXT)`
- `clips(id INTEGER PK, volume_uuid TEXT REFERENCES volumes, rel_path TEXT NOT NULL, byte_size INTEGER, quick_hash TEXT, full_hash TEXT, tb_num INTEGER, tb_den INTEGER, duration_ticks INTEGER, fps_num INTEGER, fps_den INTEGER, is_vfr INTEGER DEFAULT 0, codec TEXT, width INTEGER, height INTEGER, captured_at TEXT, gps_lat REAL, gps_lon REAL, imported_at TEXT, missing_since TEXT)` — **时间一律整数 tick + 分数时间基,禁止浮点秒列**
- `segments(id INTEGER PK, clip_id INTEGER REFERENCES clips, in_ticks INTEGER, out_ticks INTEGER, kind TEXT, scene_index INTEGER)`
- `ratings(id INTEGER PK, segment_id INTEGER REFERENCES segments, rating_type TEXT, value INTEGER, rated_at TEXT)` — 追加式,不 UPDATE 覆盖
- `tags(id INTEGER PK, segment_id INTEGER, label TEXT, source TEXT, confidence REAL)`
- `jobs(id INTEGER PK, kind TEXT, payload TEXT, payload_hash TEXT, status TEXT CHECK(status IN ('pending','running','done','failed','blocked')), attempt INTEGER DEFAULT 0, blocked_summary TEXT, result_path TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT)`
- `exports(id INTEGER PK, tier TEXT, manifest TEXT, created_at TEXT, output_path TEXT)`
外键 ON;所有写操作走事务。项目库路径:开发期 `~/Library/Application Support/TripCutStudio/dev/project.db`(目录自动创建)。

## 7. 状态机
jobs:pending→running→done|failed;failed(attempt<3)→pending(退避);failed(attempt≥3)→blocked;启动恢复 running→pending。取消(cancelling)本卡不实现,枚举里预留。

## 8. 测试夹具
本卡纯数据层,不需媒体夹具。测试用 tempdir 建库。

## 9. 量化验收标准
- `cargo test` 全绿,≥8 个测试:迁移从空库到 v1;二次启动不重跑;版本高于代码支持时拒绝启动;jobs 状态机各转移;重启恢复 running→pending;attempt≥3 → blocked;axum 401/400/200 三态;rename 原子写约定的辅助函数行为。
- `npm run typecheck`、`npm run lint`、`npx vitest run` 全绿(真退出码,不许 `|| true`)。
- `npm run tauri dev` 手工验收(主审执行):窗口出现,三导航可切换,devtools 无红错。

## 10. 验证责任与命令
Codex(实施者聚焦快检):`cargo test`、`cargo clippy --all-targets -- -D warnings`、`npm run typecheck`、`npx vitest run`,在交付证据里贴命令与真退出码。**不要跑 `npm run tauri build`**(全量门禁归主审)。
Claude(主审):tauri dev 真机验收 + 全量门禁。

## 11. 失败注入与恢复验收
测试内模拟:job running 时进程"死亡"(直接重开库)→ 恢复 pending;写产物中途丢 `.tmp-*` 文件不影响重跑。

## 12. 依赖与分发约束
锁定版本写入 lockfile 并在交付证据列出关键版本(tauri、rusqlite、axum、tokio、react、vite)。新增依赖仅限:rusqlite(bundled)、axum、tokio、tower、serde、uuid、rand、thiserror、tracing;前端 react-router 或等价轻量路由。不得引入 ORM、不得引入 Python。许可证须 MIT/Apache/BSD 系。

## 13. 回滚与清理
全部为新增文件,回滚=删分支。dev 项目库在用户目录 dev/ 下,可整删。

## 14. 交付证据
提交到分支 `p1/t1-scaffold` 并 push origin。报告:7 位 SHA、变更文件树概要、四条快检命令+退出码、关键依赖版本、已知风险/留白清单。提交信息带 `Co-Authored-By: Codex <noreply@openai.com>`。

## 15. 禁改清单
`docs/**`、`spikes/**`、`README.md`、`.git` 配置。git 操作仅限:新建分支、add 本卡新增文件、commit、push。**禁用 `git add -A`/`git add .`**(有并行车道),逐路径 add。

## 16. 变更记录
- 2026-08-31 v1 派发。
- 2026-08-31 v1.1(业主指令):§3 UI 壳由"深色主题"改为**深浅色自适应**(token 化+跟随系统+设置三档覆盖,见规格 §7 主题条)。实施中途变更,主审在验收时核对,缺失由主审补齐。
