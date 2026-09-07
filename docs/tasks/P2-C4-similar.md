# 任务卡 P2-C4:相似镜头容器(Audition 式收纳)

状态:派发(主树)。实施:Codex。主审:Claude。

## 目标与依据
规格 §7 v2 项;FCP Audition 调研结论:重复镜头收进一个可切换容器而非逐条拒绝,非破坏。依赖 C2 的 clip_embeddings(BLOB 余弦)。

## 范围
- 聚类:`similar_groups()`——对全部有嵌入的 clips 算余弦相似度图,阈值 SIM_THRESHOLD=0.90(常量+注释待真机校准),连通分量成组;只成组含 ≥2 条的;结果落 migration 0006:`similar_groups(id, created_at)` + `similar_group_members(group_id, clip_id, is_primary)`;主代表默认=组内星级最高,其次 L1 角标最少,再次最早拍摄
- 触发:新 job `similar_cluster`(优先级 5,嵌入全量完成后一次性跑;嵌入有新增时重算——payload_hash 绑嵌入集指纹保幂等)
- 筛片页:同组素材折叠为一张容器卡(角标「N 连拍」),点开横向展开组内成员,Tab/点击切主代表(写 is_primary);过滤条加「隐藏重复镜头」开关(只显示主代表);容器非破坏——所有成员仍可单独评级
- 可解释:容器卡显示组内两两最低相似度分数
## 非目标
跨项目;基于时间邻近的辅助信号(纯视觉即可);自动拒绝副本。

## 验收
cargo ≥6 测试(合成向量聚类正确/阈值边界/主代表选择规则/幂等重算/成组≥2);前端 ≥2;五门全绿。真机:97 变体素材(同源多编码变体天然是重复组!)应聚出明显组,主审目测。

## 纪律
纯写不碰 git 不跑构建;禁改 docs/spikes/README、player、deliver、sidecar;迁移只加 0006。
