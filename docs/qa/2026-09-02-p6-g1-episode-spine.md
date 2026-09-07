# P6-G1 Episode Spine 验收(2026-09-02 下午)

## 实现
- 迁移 0020:episodes 加 status/episode_number/archived_at、clips.episode_id 归属、episode_archives 只增档案、单 active 部分唯一索引;旧库兼容(空表建 EP01/有行取最新为 active),既有 clips 全量归属。
- core/episode.rs:current/list/rename/archive_current(Immediate 事务:快照→封存→开下集)/assign_clip_to_current(只填空归属);空集拒绝封存。
- lib.rs 四命令;import 建 clip 即归属 active 集。
- EpisodePanel:侧栏集指示+抽屉(集列表/重命名/两击封存)。

## 验证
- cargo test 全量 334 绿(新增 4 episode 用例:单active/滚动+快照/空集拒绝/归属只填空);vitest 73(新增 2:抽屉渲染/封存二次确认);clippy -D warnings 绿;tsc 绿。
- dev 实拍:迁移 19→20 自动完成(89 clips 全归属);面板渲染;封存两击→EP01 archived(89素材留档)+EP02 active+archives 1 条+通知正确。
- 迁移暴露的三处真冲突当场修:deliver 两测试硬编码 episode_id=1(EP01 预置后自增偏移);**load_overview 把「episodes 有行」误当「有编排」——L3 开启会永远假 narrative 模式(生产级bug),改按挂章节的集判定**。

## 留给 W2
- narrative 复用 episodes 作草稿容器的语义混杂,由 G2 Narrative Revision 彻底分离。
- 历史集只读视图(筛片按集过滤)与 U1 集侧栏一起做。
