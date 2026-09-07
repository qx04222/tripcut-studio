# P6-G2 Narrative Revision 验收(2026-09-02 下午)

## 实现
- 迁移 0021:narrative_revisions(suggested/confirmed+title/theme)+chapters 整表重建(UNIQUE 从 episode_id,order 迁到 revision_id,order)+narrative_overrides(op+逆操作撤销链)。
- core/narrative_revision.rs:active_revision_id(confirmed 优先)/ensure_confirmed(深拷贝章节+Beat)/apply_op(四操作:重命名/改类型/移Beat/改角色,suggested→confirmed id 空间自动映射)/undo_last。
- **persist_draft 生产集毁灭 bug 根除**:原实现开头 DELETE FROM episodes(AI 重跑=集数据全灭);现在不动 episodes,产物落 suggested revision,只清未被引用的旧 suggested。
- 读取端:load_overview/deliver selected_clips 都按权威修订过滤(防建议版/确认版双份 join)。
- 前端:章节类型下拉+双击重命名、BEAT 徽章点击循环角色、工具条修订徽章(AI 建议版/确认版·N 次修改)+撤销编排编辑。

## 验证
- cargo test 全量绿(新增 4 revision 用例:深拷贝隔离/跨章移动+撤销/confirmed 优先+重跑不覆盖/无建议拒编辑);clippy/tsc/vitest 73 绿。
- dev 实拍(夹具模拟 AI 产物):narrative 模式渲染(Episode/Chapter/Beat+槽位+缺口红标)→点 BEAT→confirmed 自动生成+overrides 入账→撤销→role 恢复+undone_at 标记。全链 DB 双证。
- 实拍途中抓到并修复:load_overview 的「过期编排守卫」(refs 集合不等→None)行为确认正确;dev 库结构漂移(中间版 0021)手工补齐并记录。

## 留给后续
- MoveBeat 的拖拽 UI(W3 U2 工作区一起做;后端已支持含跨章)。
- 真实 L3 Canary(业主在场)将首次生成真 suggested,本轮夹具仅验证链路。
