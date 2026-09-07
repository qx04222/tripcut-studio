# 任务卡 P3-D4:Shot Stack v2 + AI Best Take(升级 C4)

状态:排队(C8 之后、D3 之前派发——D3 的槽位视图吃本卡的 Stack)。实施:Codex。主审:Claude。
依据:规格附录 D.1-D.5。升级 C4 的纯视觉聚类为功能感知折叠。

## 范围
- migration 0014:`shot_stacks(id,scene_id,subject_label,function_label,created_at)` / `shot_stack_members(stack_id,clip_id,segment_id,best_take_score REAL,score_breakdown_json,user_state TEXT CHECK(user_state IN('auto','locked','rejected','hero')))`;`scenes(id,chapter_signal_id,name,kind)`(D.2 的 Scene 层,先按信号层聚合+八维标签命名,叙事角色理解留给 D3 的 L3 编排)
- **折叠规则**:同 Scene+同主体(八维③)+同功能(八维⑤新八分类)+景别相同(八维②)+运动类别相同(C6)→同 Stack;**五类语义**:信息镜头(功能=Orientation/Information)与人物镜头(主体=人/功能=Human)**永不并入普通视觉 Stack**,各自独立成组且不做画质淘汰
- **Best Take 六轴**:Technical(L1 数值)/Motion(C6 数值+起止稳定=首尾抖动分差)/Audio(astats+转写清晰度代理)/Composition与Human(CLIP zero-shot 原型分:构图平衡/表情自然,标注"启发式代理"诚实置信)/Narrative(D3 编排后回填,本卡先置 NULL);总分=可配权重加权,score_breakdown_json 全量入库(可解释)
- 交互(筛片页+故事板):Tab 展开/↑↓切换/Enter 替换首选/L 锁定/R 排除(user_state,排除不删)/Promote 升 Hero;**人工反哺**:locked/hero 的镜头特征(功能+景别+运动组合)记入偏好表,同组合后续 Stack 首选加权
- C4 的 similar_groups 保留为"视觉近似"信号输入,不再直接驱动 UI 折叠
## 验收
cargo ≥10(折叠规则各维度边界/信息与人物豁免/六轴合成与 breakdown/user_state 流转/反哺加权);前端 ≥4;五门全绿;真机:97 条素材 Stack 数量与目测合理性、Tab 流。
## 纪律
纯写不碰 git 不跑构建;迁移只加 0014;C4 代码只降级为信号不删表。
