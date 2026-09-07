# 任务卡 P4-E3:跨集视觉记忆 + Routine Stack + DH 重复记忆

状态:排队(D3 之后派发)。实施:Codex。主审:Claude。
依据:规格附录 D.8-D.10。频道级长期记忆,跨项目存储。

## 范围
- **存储位置裁决**:跨集记忆不属于单项目 project.db——新建 `~/Library/Application Support/TripCutStudio/channel.db`(独立 schema v1:`used_shots(episode_id,clip_fingerprint,location,function_label,shot_signature/*功能+景别+运动+主体组合*/,is_hero,used_at)` / `routine_events(routine_kind,episode_id,treatment TEXT CHECK(treatment IN('explained','montage','story_event')),occurred_at)` / `dh_appearances(episode_id,mode,duration_s,style,topic,appeared_at)`);单项目导出成功时写入
- **Routine 识别**:内置 15 类房车行为词表(起床/咖啡/收营/发动/驾驶/加油/采购/倒车/调平/接水/接电/遮阳棚/做饭/篝火/睡觉),识别=八维⑥人物状态+转写关键词+CLIP 原型;`routine_suggestion`:首次→explained,重复→montage/transition,**变化检测**(同 routine+异常信号:转写情绪词/意外事件标签)→story_event 升级建议;全部只建议不强制
- **Routine Visual 降权**:shot_signature 在近 N 集(默认4)使用≥3次→标 Routine Visual,Best Take 的 Narrative 轴降权;新语境(地点变化大/天气标签异常)→Novelty 加成恢复候选
- **DH 节奏守卫**:D3 编排 prompt 注入 dh_appearances 摘要;规则层硬约束:相邻 DH 槽位间隔<2 个实拍槽→合并建议;本集 DH 累计超时长阈值→警示
- 故事板 UI:Routine 素材折叠组带 treatment 徽章;跨集重复镜头显示"EP0x 已用"角标
## 验收
cargo ≥8(channel.db 独立迁移/签名重复计数/降权与 Novelty/treatment 流转/DH 间隔规则);五门全绿;真机:模拟两次导出后重复角标出现。
## 纪律
纯写不碰 git 不跑构建;channel.db 自带 schema_version,不动 project.db 迁移序列;项目删除不影响频道记忆。
