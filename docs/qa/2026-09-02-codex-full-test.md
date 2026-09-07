

# TripCut Studio v0.3.0-alpha.8 独立全量源码 QA（2026-09-02）

## 结论与范围

本轮按“功能正确性 / UI 与交互 / 可用性”三条线，逐一审阅了指定的 6 个 v0.3 Rust 核心模块、播放器模块，以及 10 个 React 组件。结论：**未确认 P0；确认 14 条 P1、13 条 P2**。风险最集中在四处：Episode 边界没有真正约束交付与历史只读、Routine 三套处理枚举互不兼容、watched folder 的“增量”去重键永久阻止同路径变化重扫、组件下载与播放器退出仍有高风险生命周期缺口。

本报告是当前仓库状态的源码审阅与可复现测试设计。遵守“除本报告外不创建或修改文件”的约束，未运行可能写入 `target/`、缓存或快照的 Cargo/npm/Tauri 测试，也未做打包 App 真机交互；因此所有运行态条目均给出精确复现步骤，未实测的竞态或平台兼容项明确标为“假设”。

## P0

本轮没有达到 P0（确定性数据毁灭、任意代码执行、全应用不可用）的已验证发现。下面的 P1 仍包含会污染交付包、突破历史集只读语义及引入供应链风险的问题，发布前应视为阻塞项。

## P1

### 【P1】新一集的交付会混入历史集仍保留的精选与收藏

- 维度：功能正确性 / 可用性
- Evidence（证据）：
  - `src-tauri/src/core/episode.rs:168-174` 只在导入时把新 clip 归到当前 active episode；封存不会清除旧集的 ratings/select segments。
  - `src-tauri/src/core/deliver.rs:924-935` 只用 active episode 选择 narrative revision。
  - 真正选择交付素材的 SQL 位于 `src-tauri/src/core/deliver.rs:984-1023`；`FROM clips c` 后的 `WHERE` 只判断精选段或 binary 收藏，完全没有 `c.episode_id = active_episode` 条件。
  - 复现：在 EP01 收藏 A 并保存一个精选段 → 封存 EP01、进入 EP02 → 在 EP02 收藏 B → 打开交付页。`selected_clips` 会同时返回 A 与 B，EP02 交付包重复带入 EP01 素材。
- Impact（影响）：跨集污染是成片出口的硬错误；越长期使用，旧集已选素材越多，新集交付越不可控，用户可能在剪映中误用重复镜头。
- Suggested fix（建议修复）：在交付任务创建时取得并固化 `episode_id`，所有 selection/rating/narrative 查询都强制按该 episode 过滤；给两集各有收藏和精选段的夹具增加“只导出 active 集”回归测试，并验证任务运行中封存不会改变已固定的 payload。

### 【P1】历史集“只读”只是文案，筛片页仍可修改评级与精选段

- 维度：功能正确性 / UI-交互 / 可用性
- Evidence（证据）：
  - `src/SelectPage.tsx:1147-1152` 的 `viewingEpisode` 只参与列表过滤。
  - `src/SelectPage.tsx:1780-1784` 显示“正在只读查看已封存集”的 banner，但代码中 `viewingEpisode` 除过滤和 banner 外没有用于禁用任何写操作。
  - `src/SelectPage.tsx:1343-1370` 的 `persistRating` 没有历史集 guard；`src/SelectPage.tsx:1659-1662` 仍会通过键盘触发它。
  - `src/SelectPage.tsx:945-952` 仍显示立即删除精选段的按钮，`src/SelectPage.tsx:1411-1423` 也没有历史集 guard。
  - 复现：侧栏打开一个 archived episode → 点击卡片 → 按 `F`/数字键改评级，或点“删除”精选段；前端会照常调用写 API。
- Impact（影响）：界面向用户承诺只读但实际写入，历史决策与已交付依据可被无意改写，也会进一步触发上一条跨集交付污染。
- Suggested fix（建议修复）：前端统一派生 `readOnlyEpisode` 并禁用评级、精选段创建/删除、时间阶段、Stack、AI/编排写操作；后端每个写命令再校验 clip/chapter 属于 active episode，不能把 UI 禁用当权限边界。

### 【P1】封存后筛片页不会切换到新 active 集，旧集仍被当作当前集

- 维度：功能正确性 / UI-交互
- Evidence（证据）：
  - `src/SelectPage.tsx:993-1002` 只在组件首次 mount 时调用一次 `getCurrentEpisode()`；之后没有 episode-change 订阅或刷新。
  - `src/EpisodePanel.tsx:37-53` 封存成功只调用 EpisodePanel 自己的 `refresh()`，没有向 SelectPage 广播新 episode id。
  - `src/SelectPage.tsx:1147-1152` 随后继续用陈旧的 `activeEpisodeId` 过滤素材；此时 `viewingEpisode` 仍为 `null`，因此连历史只读 banner 都不会出现。
  - 复现：停留在 `/review`，从同页侧栏封存当前集；不离开该路由。主区仍显示刚封存的旧集，并保留全部写操作。
- Impact（影响）：集生命周期在同一页面内断裂；用户以为已进入新集，实际继续给旧集评级/打点，后续素材和交付归属难以理解。
- Suggested fix（建议修复）：封存返回值中的 `next.id` 应写入共享 episode store 或发布强类型事件；SelectPage、Storyboard、DeliverPage 同步刷新 scope。后端继续强制 active-episode 所有权校验。

### 【P1】Routine 的 AI 枚举、覆盖枚举和前端类型是三套不兼容协议

- 维度：功能正确性 / UI-交互
- Evidence（证据）：
  - AI 推导只会产生 `story_event`、`explained`、`montage`：`src-tauri/src/core/channel_memory.rs:758-783`；前端类型也只声明这三项：`src/api.ts:405-410`。
  - 覆盖层只接受 `beat`、`montage`、`transition`、`full`：`src-tauri/src/core/routine_override.rs:14`。
  - “全部接受”遇到 `explained` 或 `story_event` 时静默 `continue`：`src-tauri/src/core/routine_override.rs:112-127`；Storyboard 却把所有未人工确认的 suggestion 原样提交：`src/Storyboard.tsx:571-582`。
  - 覆盖层还会把 `transition/full/beat` 原样写回 `RoutineSuggestion.treatment`：`src-tauri/src/core/routine_override.rs:101-106`，突破前端声明的 union；`src/Storyboard.tsx:70-75` 又把所有非 `explained/story_event` 值兜底显示成“重复·Montage/Transition”。
  - 复现：构造首次出现的 Routine（`explained`）与出现变化的 Routine（`story_event`）→ 点“全部接受降级”；后端返回成功但跳过二者。再逐次点 Routine 徽章进入 `full`，标签仍显示 Montage/Transition。
- Impact（影响）：批量接受结果与按钮承诺不一致，人工选择在显示层被错误翻译；TypeScript 无法保护后端实际返回的数据。
- Suggested fix（建议修复）：冻结一套共享 domain enum，并显式定义“AI 建议 → 人工处理”的映射；Rust 序列化与 TS 类型从同一 schema 生成。禁止静默跳过，返回逐项结果或整批失败。

### 【P1】“非 Routine”一旦设置，恢复控件立即消失，形成不可逆 UI 死路

- 维度：功能正确性 / UI-交互 / 可用性
- Evidence（证据）：
  - `src-tauri/src/core/routine_override.rs:95-100` 对 `cleared` override 直接返回 `None`。
  - `src/Storyboard.tsx:361-378` 只有 `beat.routine_suggestion` 存在时才渲染 Routine 按钮；返回 `None` 后没有任何替代控件。
  - `src/Storyboard.tsx:561-565` 成功文案却明确说“已标记为非 Routine(可在循环中恢复)”。代码库内 `setRoutineOverride` 的 UI 调用只有这个消失的控件路径。
  - 复现：对一个 Routine 连续点击，直到 `full → clear`；刷新后徽章消失，用户无法再通过界面调用 remove override。
- Impact（影响）：人工误点后无法自助恢复 AI 建议，且成功提示具有误导性。
- Suggested fix（建议修复）：API/Storyboard 数据必须显式返回 override 状态；清除建议后保留“已豁免 Routine / 恢复 AI 建议”控件，并为恢复路径添加交互测试。

### 【P1】watched folder 的任务去重键只含路径，同路径内容变化或失败任务永远不会重扫

- 维度：功能正确性
- Evidence（证据）：
  - `src-tauri/src/core/import.rs:402-410` 的 import payload 包含 `folder_label`，但 `payload_hash` 只有 `import_probe\\\\0{path}`，不含 mtime、size、inode/file-id 或 label。
  - `src-tauri/src/core/import.rs:429-439` 查询任意状态的同 kind/hash job；只要历史 job 存在（包括 done、failed、blocked），就永久返回 `None`，不重新入队。
  - `src-tauri/src/core/import.rs:296-323` 所谓增量同步只反复调用这条 enqueue 路径。
  - 复现 A：关注目录中导入 `A.mp4`，等待 job done → 用不同视频覆盖同一路径 → “立即扫描”；结果 `enqueued=0`。复现 B：让该路径 job 进入 blocked，修好 ffprobe/权限后重扫；仍不会创建可运行的新 job。
- Impact（影响）：NAS/云盘常见的同名更新、相机覆盖和故障恢复都会被宣称为“没有新素材”，增量同步漏片且无补救入口。
- Suggested fix（建议修复）：去重身份至少纳入稳定 file identity + size + mtime（最终仍以 quick/full hash 确认）；只阻止 active/pending 的同代任务，允许 done 内容变化和 blocked 手动重试，并把代次写入 payload hash。

### 【P1】素材在子文件夹间移动会被当作“重复文件”丢弃，路径与 folder_label 均不更新

- 维度：功能正确性 / 可用性
- Evidence（证据）：
  - `src-tauri/src/core/import.rs:338-357` 以第一级子目录生成 `folder_label`。
  - `src-tauri/src/core/import.rs:484-496` 发现相同 quick hash + size、但 volume/path 不同，就立即返回 `Duplicate`。
  - 更新 clip 路径和 `folder_label` 的代码在更后面的 `src-tauri/src/core/import.rs:519-621`，duplicate 早退不会到达。
  - 复现：先导入 `/Trip/A/shot.mp4`（label=A）→ 在 Finder 移到 `/Trip/B/shot.mp4` → watched folder 重扫。新路径被判重复，数据库仍指向已不存在的 A 路径，B 标签也不会落库。
- Impact（影响）：用户按文件夹整理素材这一核心 v0.3 工作流与去重逻辑冲突；整理后播放器会继续寻找旧路径，分类过滤也显示旧标签。
- Suggested fix（建议修复）：duplicate 分支区分“副本”和“同一素材搬迁”；旧路径不可达且新候选可验证时执行受审计的 relink，并同步 `folder_label`。存在两个可达副本时再按明确策略去重。

### 【P1】全局搜索摘录对 Unicode 小写扩展使用错误字节下标，可触发 Rust panic

- 维度：功能正确性
- Evidence（证据）：
  - `src-tauri/src/core/global_search.rs:21-30` 在 `text.to_lowercase()` 上取得 byte index，却用该 index 切原始字符串 `text[..byte_index]`。
  - Unicode lowercasing 可能改变字节长度。确定性最小复现：调用 `excerpt_around(\\"İé\\", \\"é\\", 18)`；lowercase 为 `i\\\\u{307}é`，`find` 返回 byte index 3，而原文 index 3 位于 `é` 的 UTF-8 编码中间，`text[..3]` 会 panic。
  - `src-tauri/src/core/global_search.rs:44-60` 对每条数据库命中无保护地调用该函数，因此包含此类文本的转写/AI 描述可从正常搜索入口触发。
- Impact（影响）：特定合法 Unicode 文本会让搜索命令 panic；取决于 panic 配置，至少本次命令失败，最坏可终止进程。
- Suggested fix（建议修复）：不要跨两个不同字符串复用 byte offset；用 Unicode case-fold 后维护原文 grapheme/char 映射，或先在原文做安全的 char-boundary 搜索。加入 `İé`、组合音标、emoji 邻接字符回归用例。

### 【P1】全局搜索结果缺少 episode 上下文，点击历史素材会被当前集过滤器立即改选

- 维度：功能正确性 / UI-交互 / 可用性
- Evidence（证据）：
  - `src-tauri/src/core/global_search.rs:11-17` 的 hit 只有 kind、clip_id、file_name、excerpt；`src-tauri/src/core/global_search.rs:65-103` 搜索全库但不返回 `episode_id`。
  - `src/App.tsx:224-228` 点击命中只切到 `/review` 并广播 clip id，不切换 episode scope。
  - `src/SelectPage.tsx:1147-1152` 默认只显示 active episode；`src/SelectPage.tsx:1328-1341` 若传入 clip 不在当前 wall，会把 selection 改成当前列表第一项。
  - 复现：EP01 有独有关键词并已封存，EP02 为当前集 → Cmd+K 搜该词并点结果；页面进入筛片页，但不会打开 EP01，目标 clip 随即被替换为 EP02 第一项。
- Impact（影响）：号称“全量搜索 / 素材直达”的核心路径对历史素材是死链接，用户会误以为搜错或素材丢失。
- Suggested fix（建议修复）：hit 返回 `episode_id` 与 episode title/status；导航事件同时设置历史只读 scope，再选 clip，并在结果中标注所属集。

### 【P1】Narrative 首次编辑的 ID remap 可把其他集/其他修订的 ID 映射到当前确认版

- 维度：功能正确性
- Evidence（证据）：
  - `src-tauri/src/core/narrative_revision.rs:264-325` 的 remap 仅比较 owner revision 是否等于 confirmed；不验证来源 revision 是否是当前 confirmed 的 `based_on_revision_id`，也不验证 episode。
  - 章节 remap SQL `src-tauri/src/core/narrative_revision.rs:272-282` 只按 `order` 把任意 `c1.id` 映到 confirmed；Beat remap `src-tauri/src/core/narrative_revision.rs:295-308` 也只按章 order + beat order。
  - `src-tauri/src/core/narrative_revision.rs:328-343` 随后在事务内直接执行映射后的操作。
  - 复现：让当前集确认版与历史集都存在 order=0 章节；向 `apply_narrative_op` 传历史章节 id 和当前集 episode（Tauri 命令自动取当前集）。历史 id 会被映到当前确认版 order=0 并改写它，而不是报“请刷新”。
- Impact（影响）：陈旧 UI、封存并发或错误调用可把用户针对旧故事板的编辑静默作用到新集，破坏 draft/confirmed 隔离的可信度。
- Suggested fix（建议修复）：只允许 op ID 属于当前 confirmed，或严格属于其唯一 `based_on_revision_id`；同时校验 chapter.episode_id 与目标 episode、一条 Beat 的源/目标章节均在同一 confirmed revision。否则返回 stale-revision 冲突。

### 【P1】Chinese-CLIP 安装的“取消”按钮不会取消安装进程

- 维度：功能正确性 / UI-交互
- Evidence（证据）：
  - `src/SetupWizard.tsx:118-120` 对所有安装中的组件显示“取消”。
  - `src-tauri/src/lib.rs:453-465` 取消命令只把 `AtomicBool` 置为 false。
  - FFmpeg 下载循环会读取该 flag：`src-tauri/src/core/provisioning.rs:153-158`；但 `clip-sidecar` 分支 `src-tauri/src/core/provisioning.rs:247-266` 直接阻塞等待 `/bin/bash setup.sh` 完成，从未读取 flag，也没有保存/kill child handle。
  - `sidecar/setup.sh:11-16` 会创建 venv 并执行三个网络 pip install，可能持续很久。
  - 复现：开始 2.4GB Chinese-CLIP 安装 → 点击取消 → 观察 pip/batch 进程仍继续，最终任务仍可成功完成。
- Impact（影响）：用户无法停止耗时、耗流量、占磁盘的操作，按钮提供虚假控制感；退出向导也不会终止后台线程。
- Suggested fix（建议修复）：用 `spawn` 保存 child，轮询 flag 并终止整个进程组；定义取消后的 staging 清理和可重试状态。不能取消时移除按钮并明确说明。

### 【P1】组件下载无哈希/签名校验，并直接覆盖可执行文件后移除 quarantine

- 维度：功能正确性 / 安全性
- Evidence（证据）：
  - `src-tauri/src/core/provisioning.rs:21-25` 使用可变的 `latest` 第三方 FFmpeg redirect 和 Hugging Face URL，没有固定版本/digest。
  - `src-tauri/src/core/provisioning.rs:134-178` 只要求 curl HTTP 成功便 rename，不校验 SHA-256、签名或预期长度。
  - `src-tauri/src/core/provisioning.rs:207-221` 找到同名文件后直接 `copy` 到最终 executable，随后忽略错误地删除 quarantine；没有同文件系统临时目标 + fsync + atomic rename，也不验证可执行文件身份。
- Impact（影响）：上游/重定向/缓存被污染时，应用会信任并执行未验证二进制；安装中断或磁盘故障还可能截断一个原本可用的最终文件。
- Suggested fix（建议修复）：固定版本与每架构 digest，下载后校验哈希/大小/签名，再写入同目录临时文件并原子 rename；仅在校验成功后处理 quarantine，且 xattr 失败应进入可见错误状态。

### 【P1】播放器关闭超时后丢失唯一 JoinHandle，旧渲染线程和原生视图无法再回收

- 维度：功能正确性 / UI-交互
- Evidence（证据）：
  - `src-tauri/src/player/mod.rs:319-335` 先从 ManagerState `take()` session；若 Shutdown 已发送但 3 秒内未 ack 且线程未结束，就直接返回错误。
  - 该分支返回时局部 `session` 被 drop，`JoinHandle` 被 detach，manager 已不再持有 sender/status/handle；后续 `open()` 可在 `src-tauri/src/player/mod.rs:221-258` 创建新 session。
  - 原生 view 只有 worker 走到 `src-tauri/src/player/mod.rs:625-628` 才安排移除和 ack；卡死线程不会走到这里。
  - 复现：在 native teardown/render call 上注入超过 3 秒的阻塞 → 调用 close → 收到“播放器关闭超时” → 再 open 新 clip。Manager 只跟踪新线程，旧 view/thread 没有第二次 shutdown/join 路径。
- Impact（影响）：可能留下叠加的 NSOpenGLView、持续线程和 libmpv context；重复进入播放器会累积资源，并增加退出崩溃或原生渲染冲突概率。
- Suggested fix（建议修复）：超时 session 保留在 `closing/orphaned` 状态并禁止新 open；使用可中断的 worker 状态机、第二阶段回收和最终 Drop/Exit hook，直到 view removal 确认完成再释放句柄。

### 【P1】组件/工具检测失败被解释成“已就绪”或“不缺失”

- 维度：UI-交互 / 可用性
- Evidence（证据）：
  - SetupWizard 的 `refresh` 在失败时把组件置为空数组：`src/SetupWizard.tsx:34-38`；`missingCritical` 用 `components.some(...)`：`src/SetupWizard.tsx:80-82`，空数组因此为 false；footer 随即显示“核心组件已就绪”：`src/SetupWizard.tsx:157-165`。
  - ImportPage 在 `getSettingsStatus` 失败时执行 `setToolchainMissing(false)`：`src/ImportPage.tsx:483-487`，隐藏工具缺失警告。
  - 复现：让 `get_component_statuses` 或 `get_settings_status` IPC 拒绝（例如数据库暂时锁住）→ 向导显示已就绪，导入页也不显示风险，而不是“检测失败”。
- Impact（影响）：错误状态被错误地归类为健康，用户会继续导入，随后才遇到难以关联的探测失败。
- Suggested fix（建议修复）：建立 `loading | ready | error` 三态；检测失败绝不能推断 ready，显示错误与重试按钮。critical readiness 必须要求成功响应且明确全部满足。

### 【P1】Storyboard 仍有一处 setState updater 延迟读取 SyntheticEvent

- 维度：UI-交互
- Evidence（证据）：
  - 全仓针对该模式的多行检索后，剩余实例位于 `src/Storyboard.tsx:870-873`：`setTitleDrafts` 的 functional updater 内部读取 `event.currentTarget.value`。
  - 同文件其他输入已采用先同步取值再进入 updater 的安全写法，例如 `src/Storyboard.tsx:466-472`；Settings 也明确说明并采用安全写法：`src/SettingsPage.tsx:866-870`。
  - 复现建议：在 React concurrent/Strict 环境下快速输入章节名，同时触发一次上层状态更新；让 updater 在 handler 返回后执行。此时 `currentTarget` 不保证仍指向 input，可出现 null 读取、白屏或丢字。本条是代码路径已确认、具体调度窗口待受控测试确认的竞态。
- Impact（影响）：章节重命名仍保留与此前同类白屏问题相同的失效事件风险，且属于用户输入主路径。
- Suggested fix（建议修复）：handler 第一行 `const value = event.currentTarget.value`，updater 只捕获 `value`；增加延迟执行 updater 的回归测试并继续以 AST/ESLint 规则禁止 updater 捕获事件对象。

## P2

### 【P2】Episode archive 的持久快照记录的是封存前状态

- 维度：功能正确性
- Evidence（证据）：
  - `src-tauri/src/core/episode.rs:121-134` 先调用 `summary_by_id` 得到 `status='active'`、`archived_at=None` 的 snapshot，并立刻序列化到 `episode_archives.summary_json`。
  - 真正把 episode 改为 archived 并写 archived_at 在更后的 `src-tauri/src/core/episode.rs:135-140`。
  - 现有测试 `src-tauri/src/core/episode.rs:223-237` 只断言 archive 行数为 1，没有反序列化检查快照状态。
- Impact（影响）：只增审计快照与最终 episode 行自相矛盾；以后做归档恢复/展示时会把已封存集解释成 active。
- Suggested fix（建议修复）：先在事务中更新 episode，再重新查询最终 summary 后序列化；或构造明确的 ArchiveSnapshot schema。测试应断言 status、archived_at、统计值和数据库行一致。

### 【P2】Routine “全部接受”不是事务，失败会留下部分成功但 UI 只报整批失败

- 维度：功能正确性
- Evidence（证据）：
  - `src-tauri/src/core/routine_override.rs:112-127` 在普通 `&Connection` 上逐条 execute，没有 transaction/savepoint。
  - 复现：建议数组第一项为存在 clip 的合法 `montage`，第二项为不存在 clip 的合法 treatment；第一条自动提交，第二条触发 FK 错误，函数返回 Err。`src/Storyboard.tsx:580-586` 只显示“批量接受失败”，但第一项已经持久化。
- Impact（影响）：重试结果和用户理解不一致，批量操作失去原子性。
- Suggested fix（建议修复）：在 Immediate transaction 内验证全量 clip 归属与 treatment，再统一 insert/commit；若产品要 best-effort，则返回逐项 accepted/skipped/failed，不得只返回一个计数。

### 【P2】离线 watched folder 被静默跳过，UI 会把“未扫描”显示成“没有新素材”

- 维度：功能正确性 / 可用性
- Evidence（证据）：
  - `src-tauri/src/core/import.rs:304-309` 对不存在/未挂载目录直接 `continue`，不累计 unavailable 数、不返回 warning，也不更新 last_scan。
  - `src/ImportPage.tsx:594-603` 只根据返回 count 判断；count=0 就显示“没有新素材”。
  - 复现：关注一个 NAS 路径 → 断开 NAS → 点击“立即扫描”；结果是“没有新素材”，而不是“目录不可达，本轮未扫描”。
- Impact（影响）：创作者可能在出发前误以为云盘/NAS 已同步完成，直到交付才发现素材从未被扫描。
- Suggested fix（建议修复）：返回结构化 summary（scanned/unavailable/failed/enqueued），每个 folder 保存 last_error/last_attempt_at；UI 区分“扫描成功且无新增”和“未扫描”。

### 【P2】CommandPalette 与 SidebarSearch 都允许旧请求覆盖新查询

- 维度：UI-交互
- Evidence（证据）：
  - CommandPalette debounce 后直接 `.then(setDeepHits)`：`src/CommandPalette.tsx:49-62`，没有 request id、AbortController 或 query 比对。
  - SidebarSearch 同样直接 `.then(setHits)`，任意请求完成都会 `.finally(setBusy(false))`：`src/SidebarSearch.tsx:27-42`。
  - 复现：输入查询 A 等 250ms 使请求发出 → 快速替换为 B 并发出第二请求 → 让 B 先返回、A 后返回。输入框显示 B，但结果最终回退成 A；侧栏还可能被 A 提前清掉 B 的 busy 状态。
- Impact（影响）：网络/SQLite繁忙时结果与输入不一致，用户可能点错素材。
- Suggested fix（建议修复）：使用递增 request id（SelectPage 的 `searchRequestRef` 已有可复用范式）或 abort；只有最新 query 可提交 hits/error/busy。

### 【P2】Storyboard 的 Narrative 拖拽与章节重命名缺少键盘等价操作

- 维度：UI-交互 / 可访问性
- Evidence（证据）：
  - `src/Storyboard.tsx:589-613` 只注册 `PointerSensor`，没有 `KeyboardSensor`。
  - narrative beat 在 `src/Storyboard.tsx:1001-1010` 只通过 Sortable 拖拽排序，不像 legacy card 的 `src/Storyboard.tsx:277-288` 那样提供“上移/下移”按钮。
  - narrative 章节标题是带 `onDoubleClick` 的 `<strong>`：`src/Storyboard.tsx:959-968`，不可 Tab 聚焦，也没有键盘 handler。
- Impact（影响）：只用键盘、触控辅助或不擅长精细拖拽的用户无法完成 Narrative 核心编辑。
- Suggested fix（建议修复）：接入 dnd-kit `KeyboardSensor` 与 sortable keyboard coordinates，同时保留明确的上移/下移/移到章节按钮；章节标题改为 button 或常驻输入框。

### 【P2】三个模态入口都没有完整的焦点约束，播放器进度条也不是键盘可用的 slider

- 维度：UI-交互 / 可访问性
- Evidence（证据）：
  - SetupWizard 声明 modal：`src/SetupWizard.tsx:84-86`，但没有 focus trap、初始 focus、Escape handler 或关闭后焦点恢复。
  - CommandPalette backdrop/Command 位于 `src/CommandPalette.tsx:82-95`；只用 document keydown 关闭，未记录/恢复触发元素。
  - PlayerOverlay dialog 只把容器 focus：`src/PlayerOverlay.tsx:128-174`、`src/PlayerOverlay.tsx:345-355`，没有 Tab 循环或背景 inert。
  - 播放进度使用普通 button + pointer `clientX` 计算：`src/PlayerOverlay.tsx:330-336`、`src/PlayerOverlay.tsx:369-400`，没有 `role=slider`、`aria-valuenow` 或左右键按时间寻址；键盘激活 click 也没有可靠 pointer 坐标。
- Impact（影响）：焦点可逃到被遮挡的后台控件，关闭后用户失去位置；键盘/读屏用户无法精确跳转播放位置。
- Suggested fix（建议修复）：采用统一 Dialog primitive 管理 trap、Escape、inert 和 restoreFocus；进度改为语义 slider，提供 Arrow/Page/Home/End 行为与可读时间值。

### 【P2】SidebarSearch 声明 listbox，却用普通 button 作为直接选项

- 维度：UI-交互 / 可访问性
- Evidence（证据）：`src/SidebarSearch.tsx:55-72` 容器为 `role=\\"listbox\\"`，直接子项却是没有 `role=\\"option\\"`、`aria-selected`、roving focus/active-descendant 的 `<button>`。
- Impact（影响）：读屏软件得到互相冲突的 widget 语义；上下键 listbox 导航并未实现。
- Suggested fix（建议修复）：要么使用普通结果列表 `<ul><li><button>`，要么完整实现 combobox/listbox pattern（输入 `aria-controls/expanded/activedescendant`、option 与键盘导航）。

### 【P2】筛片页的评级计数跨越所有集，与当前显示范围不一致

- 维度：功能正确性 / 可用性
- Evidence（证据）：`src/SelectPage.tsx:1147-1165` 先算当前/历史 episode scope，但 tab 计数在 `src/SelectPage.tsx:1215-1222` 重新对原始 `clips` 全量计算，而不是 `episodeScopedClips`/`folderScopedClips`。
- Impact（影响）：当前集可能显示“收藏 20”，实际墙上只有本集 3 条；历史只读查看时同样显示全库数字，造成“过滤器漏片”的错觉。
- Suggested fix（建议修复）：明确产品语义；若 tabs 表示当前视图，计数必须从同一 scope/filter pipeline 计算，并在跨集总览另设独立指标。

### 【P2】删除精选段立即生效，没有确认、撤销或恢复入口

- 维度：可用性 / UI-交互
- Evidence（证据）：`src/SelectPage.tsx:945-952` 点击“删除”直接调用 handler；`src/SelectPage.tsx:1411-1423` 立即调用 `deleteSelectSegment`，成功后只显示“精选段已删除”，没有 confirm/undo。
  - 后端执行 tombstone：`src-tauri/src/core/ratings.rs:122-126`，但该页面没有 untombstone/撤销入口。
- Impact（影响）：一次误点会移除精心打好的 in/out 决策；虽数据库保留 tombstone，普通用户无法恢复。
- Suggested fix（建议修复）：提供短时“撤销删除”toast（优先）或确认对话框；后端暴露受限 restore，并确保重复点击幂等。

### 【P2】watched folder 的开关与移除操作没有错误反馈

- 维度：UI-交互 / 可用性
- Evidence（证据）：`src/ImportPage.tsx:610-627` 的 toggle 与 remove 都只有 `.then(refreshWatched)`，没有 `.catch`、busy/disabled 或 optimistic rollback；`refreshWatched` 本身还在 `src/ImportPage.tsx:475-477` 把读取错误吞成空数组。
- Impact（影响）：数据库写失败时用户看不到原因；刷新读取失败时全部关注目录会像被删除一样消失，容易重复操作。
- Suggested fix（建议修复）：每行维护 pending/error 状态，写失败回滚并显示；读取失败保留上次成功列表，不得用空数组替代错误。

### 【P2】SettingsPage 用 Promise.all 全有或全无地加载六类数据

- 维度：UI-交互 / 可用性
- Evidence（证据）：`src/SettingsPage.tsx:344-373` 将 settings、tool status、app info、LLM status/ledger、device clocks 放在一个 `Promise.all`；任何一个低优先级请求失败，整个 then 都不执行，页面继续显示 `DEFAULT_SETTINGS`。
- Impact（影响）：例如调用账本读取失败也会阻止本地设置和工具状态显示；用户看到默认值，难以判断哪些是真实配置、哪些只是 fallback。
- Suggested fix（建议修复）：以 `Promise.allSettled` 或分区独立加载；核心 settings 成功后先展示，每个卡片有自身 loading/error/retry，默认值必须标注为默认而非已加载值。

### 【P2】设置页向普通创作者暴露大量内部术语，缺少结果导向解释

- 维度：可用性
- Evidence（证据）：设置导航直接使用“并发与代理文件”“多设备时钟校正”“本地依赖与模型”：`src/SettingsPage.tsx:78-84`；保存时提示“worker 并发”：`src/SettingsPage.tsx:389-395`；设备时钟成功文案使用“Canonical Journey Time”：`src/SettingsPage.tsx:460-472`；工具区要求理解 `whisper-cli`、模型文件和 `Chinese-CLIP sidecar`：`src/SettingsPage.tsx:706-751`。
- Impact（影响）：中等电脑水平的视频创作者难以预测改动会改善什么、是否需要重启、何时应该选择 small 模型或校时，容易把诊断项当日常必设项。
- Suggested fix（建议修复）：主层改为任务语言（“播放卡顿时降低/提高”“不同相机时间对不上”“启用对白识别/画面搜索”），技术名放进“高级详情”；给每项显示推荐值、代价和生效时机。

### 【P2】SetupWizard 安装状态/轮询失败会静默停住，重新打开也不能接管正在执行的任务

- 维度：UI-交互 / 可用性
- Evidence（证据）：`src/SetupWizard.tsx:45-68` 只轮询组件本地 `installing` Map，poll error 被 `.catch(() => undefined)` 吞掉；关闭组件后 state 丢失。
  - 重新打开时 `installing` 初始为空：`src/SetupWizard.tsx:29-32`，只看 `component_status`；进行中的安装尚未变为 installed，于是 `src/SetupWizard.tsx:113-120` 又显示“一键安装”而不是恢复进度。
  - 后端任务实际保存在全局 map：`src-tauri/src/lib.rs:319-327`、`src-tauri/src/lib.rs:386-408`。
- Impact（影响）：长下载看似冻结；关闭再打开后用户会重复点击并只得到“正在安装中”，却仍看不到进度/取消入口。
- Suggested fix（建议修复）：向导 mount 时查询全部 active tasks 并重建 UI state；poll failure 显示可重试错误，任务完成/取消后清理 backend map。

### 【P2】DeliverPage 的 interval 允许状态请求重叠，旧响应可能回写到新状态之上（假设）

- 维度：UI-交互
- Evidence（证据）：`src/DeliverPage.tsx:283-303` 用 `setInterval` 每 750ms/2s 发起 async `getExportStatus`，没有 in-flight 锁或 request generation；前一请求超时并不会阻止下一请求开始，任何完成的响应都直接 `setStatus`。
- Impact（影响）：若一次 IPC/数据库读取超过轮询间隔，较旧 snapshot 可能后到，进度短暂倒退，甚至让 interval 在 running/done 两档间反复重建。本条为代码可达竞态假设；需通过 mock 延迟交错返回确认可见表现。
- Suggested fix（建议修复）：改为一次请求完成后再 `setTimeout` 下一次，或用 sequence id 丢弃旧响应；状态机同时拒绝 stage/progress 倒退。

### 【P2】播放器 React 清理 fire-and-forget，快速切换可能让旧 close 与新 open 交错（假设）

- 维度：UI-交互 / 功能正确性
- Evidence（证据）：`src/PlayerOverlay.tsx:128-174` effect cleanup 只执行 `void playerClose()`，不等待关闭完成；同一依赖 effect 可立即为新 `clip.id` 执行 setViewport/open。
  - 后端 close/open 都通过独立 `spawn_blocking`：`src-tauri/src/lib.rs:1153-1175`；PlayerManager 虽用 operation mutex 串行化，但 IPC 到达/锁竞争顺序并未由前端 await 明确固定。
- Impact（影响）：快速切换/卸载重挂播放器时，旧 close 理论上可在新 open 之后取得锁并关掉新 session。该条需用延迟 close 的集成测试确认实际 Tauri IPC 顺序。
- Suggested fix（建议修复）：把播放器生命周期提升到单一 controller，以 session generation/token 关联 open/close；下一次 open 必须 await 前一次 close，后端 close 只作用于匹配的 session id。

### 【P2】FFmpeg/FFprobe 下载固定为 arm64，仓库没有声明 Intel 构建被禁止（假设）

- 维度：功能正确性 / 可用性
- Evidence（证据）：`src-tauri/src/core/provisioning.rs:21-24` 两个 URL 都硬编码 `/macos/arm64/`；`src-tauri/tauri.conf.json:30-49` 仅声明 dmg 与 macOS 14，未限制 bundle architecture 或给 Intel 用户错误提示。
- Impact（影响）：如果项目构建/分发 x86_64 DMG，安装向导会下载不能在 Intel 原生执行的工具。本条取决于实际发布矩阵；当前仓库未找到“仅 Apple Silicon”硬门。
- Suggested fix（建议修复）：用 `std::env::consts::ARCH`/编译 target 选择受支持 URL 与 digest；若产品只支持 Apple Silicon，在构建、下载入口和用户文档三处明确拒绝 x86_64，并用 CI 校验。

### 【P2】剪映实验草稿点击后直接写入，没有在写入前展示目标与最终确认

- 维度：可用性 / UI-交互
- Evidence（证据）：`src/DeliverPage.tsx:154-169` 只以卡片标题和 tooltip 说明实验功能，按钮点击直接触发；`src/DeliverPage.tsx:342-350` 立即调用 `generateJianyingDraft()`，没有确认或写入目标预览。
- Impact（影响）：普通用户可能把“生成”理解成预览，自身剪映草稿列表却已新增项目；失败时又会立刻弹出稳定包目录选择，交互跳转突兀。
- Suggested fix（建议修复）：首次使用显示确认页，明确剪映版本、草稿名、目标目录、“只新增不改旧草稿”和回滚方式；失败后先解释再由用户主动选择“改用稳定包”。

## 覆盖核对

| 指定目标 | 实际路径 | 覆盖与结论 |
|---|---|---|
| Episode lifecycle | `src-tauri/src/core/episode.rs` | 已审：单事务滚动成立；发现归档快照时序、交付跨集与 UI scope/只读边界问题。 |
| Narrative revision | `src-tauri/src/core/narrative_revision.rs` | 已审：suggested 深拷贝、confirmed 优先、undo 事务；发现跨 episode/revision 的 order-based ID remap。参数均绑定，未发现用户输入 SQL 注入。 |
| Routine override | `src-tauri/src/core/routine_override.rs` | 已审：发现枚举协议分裂、cleared 恢复死路、批量非事务。SQL 使用 params，未发现注入。 |
| Global search | `src-tauri/src/core/global_search.rs` | 已审：LIKE wildcard 有转义且 query 参数绑定；动态 SQL只插入常量 limit，未发现 SQL 注入；发现 Unicode panic 与历史结果导航缺上下文。 |
| Provisioning | `src-tauri/src/core/provisioning.rs` | 已审：发现取消不覆盖 sidecar、无完整性/原子安装、arm64 假设。 |
| Import / watched folders / folder_label | `src-tauri/src/core/import.rs` | 已审：发现永久 path-only dedup、搬迁不 relink/不更新 label、离线目录静默跳过。 |
| Player render lifecycle | `src-tauri/src/player/mod.rs` | 已审：检查主线程 view、worker callback、shutdown/join；发现 close timeout 丢失回收权；另记录 React close/open 交错假设。 |
| SetupWizard | `src/SetupWizard.tsx` | 已审：检测失败被判健康、取消无效、轮询错误/重开接管、模态焦点。 |
| CommandPalette | `src/CommandPalette.tsx` | 已审：旧响应覆盖、历史素材跳转、焦点恢复。 |
| SidebarSearch | `src/SidebarSearch.tsx` | 已审：旧响应覆盖、listbox 语义、历史素材跳转。 |
| EpisodePanel | `src/EpisodePanel.tsx` | 已审：封存双击确认存在；发现新 active episode 未通知其他页面。 |
| SelectPage | `src/SelectPage.tsx` | 已审：发现历史只读可写、active id 陈旧、跨集计数、删除无撤销；其语义/对白搜索已有 request id，未重复报告该路径竞态。 |
| Storyboard | `src/Storyboard.tsx` | 已审：发现 Routine 协议/恢复、跨修订编辑风险、遗留 SyntheticEvent updater、键盘不可达。 |
| PlayerOverlay | `src/PlayerOverlay.tsx` | 已审：timer/ResizeObserver/window listener 均有 cleanup；发现 modal/slider 可访问性与 close/open 交错假设。 |
| ImportPage | `src/ImportPage.tsx` | 已审：主轮询有 cleanup；发现错误即健康、离线误报、关注目录操作吞错。 |
| SettingsPage | `src/SettingsPage.tsx` | 已审：保存队列和版本回滚存在；发现首载全有或全无与技术术语过重。 |
| DeliverPage | `src/DeliverPage.tsx` | 已审：listener cleanup 存在；发现重叠轮询假设与实验草稿缺少写入前确认。 |

## 建议的最小回归矩阵

1. 两集夹具：EP01 与 EP02 各有 rating/select/narrative，验证所有写 API、Storyboard 和 Deliver 只作用于 active episode，历史查看全部返回只读错误。
2. Routine 协议表驱动：`explained/montage/story_event` × `beat/montage/transition/full/clear/remove`，验证序列化、显示、批量原子性与恢复路径。
3. Watched folder：新增、同路径覆盖、blocked 后修复、A→B 子目录移动、NAS 离线/恢复、嵌套 watched roots；核对 job 代次、rel_path、folder_label 与 UI summary。
4. Provisioning：校验错误 digest、磁盘满、取消 curl、取消 pip 进程树、重开向导接管、arm64/x86_64；最终文件只允许原子晋升。
5. Player lifecycle：open→resize→close、close timeout→重试、快速 clip 切换、窗口退出、主线程拥塞；断言任意时刻最多一个 worker/NSOpenGLView 且都可 join/remove。
6. React 受控延迟：搜索响应 A/B 乱序、轮询响应乱序、章节输入 updater 延迟、episode 封存事件；用 fake timers 和 deferred promises 验证最后意图获胜。
7. 键盘/读屏：Setup/Command/Player 三个 dialog 的 trap/restore，Storyboard beat 全键盘排序，搜索结果语义与进度 slider。

## 我认为最该先修的 5 条

1. **交付 SQL 强制按 active episode 过滤**：它会直接把旧集镜头带进新成片，是最终产物污染。
2. **历史集只读做成前后端硬边界，并广播封存后的新 episode**：否则“集”只是筛选文案，不是可信生命周期。
3. **统一 Routine enum 并补回 clear→restore**：当前批量接受、逐条循环和显示都在说不同语言，人工裁量不可相信。
4. **重做 watched folder 去重/搬迁语义**：path-only 永久去重会漏掉覆盖、故障恢复和整理后的素材，正中 v0.3 核心工作流。
5. **组件安装加固定版本/digest、原子晋升和真实取消**：这是既影响供应链安全、又影响新手首次成功率的基础门。

---

## 修复进度追踪(Claude,2026-09-02 夜 → 09-03)

### 已修(带回归测试,全门禁绿)
- 【P1】全局搜索 Unicode 下标 panic → char 序列比对
- 【P1】历史集"只读"只是文案 → 后端 ensure_clip_writable 守卫 + 前端拦截
- 【P1】watched folder 永不重扫 → 去重键纳入 size+mtime
- 【P1】素材跨子文件夹移动被当重复丢弃 → 判重时检查旧路径是否还在
- 【P1】Routine 三套枚举不兼容 → 统一六档 + 迁移 0026 放宽 CHECK
- 【P1】组件下载无校验 → 完整性校验 + 运行自检 + 原子替换

### 额外发现(报告之外,Claude 打包时实测)
- 【P0 分发】`.app` 内仍含 libx264/libx265:根因是 Homebrew 的 libmpv 链接 GPL 版 libavcodec。
  自编 LGPL ffmpeg 只解决了直接依赖,libmpv 必须一并重编(进行中)。
  教训:GPL 传染要看**整棵依赖树**,不能只看自己直接链接的库。
