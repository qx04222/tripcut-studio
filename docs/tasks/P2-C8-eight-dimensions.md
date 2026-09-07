# 任务卡 P2-C8:旅行素材八维标签体系(业主分类法落地)

状态:排队(E2 后派发)。实施:Codex。主审:Claude。
依据:业主提供的 8 维分类法(已录入规格附录 B);杠杆=Chinese-CLIP zero-shot 原型分类,不引新模型。

## 八维覆盖方案
- **①运动**:沿用 C6;补 follow 细分:|全局位移|大且去平移残差低+方向一致→handheld_follow,残差高→handheld_shaky
- **②景别/③主体/④视角/⑤功能/⑥人物状态**:CLIP zero-shot——`sidecar/prototypes.json` 定义各维中文原型组(每维 3-8 条,如 景别:["远处的风景全貌","人物全身与环境","人物上半身","面部或物体的特写"];主体:["人物","自然风景","建筑地标","食物","交通工具","动物","商品","局部细节"];视角:["平视拍摄","从高处俯拍","从低处仰拍","第一人称视角行走","无人机航拍"];功能与人物状态同法);sidecar 新增 `classify(image, dimension_prototypes) -> scores`(文本原型向量可缓存);每镜头代表帧逐维取 top-1+分数,置信度 <0.22(常量待校准)标"不确定"而非硬贴
- **⑦时间阶段**:规则合成——章节序位置+captured_at 当地时段(6-9出发倾向/11-14吃饭窗口+主体=食物强化/17-19日落+画面暖色调 YAVG 辅证/末章=返回)+可被用户改写;标签只作建议
- **⑧声音**:规则合成——转写覆盖率>40%→talking;有音轨无转写+astats 动态范围→ambient/action;无音轨→silent;(音乐/VO 识别标"未来项",诚实不猜)
- 落库:migration 0012:`clip_dimensions(clip_id, dimension TEXT, label TEXT, score REAL, source TEXT, PRIMARY KEY(clip_id,dimension))`;新 job `classify_dims`(优先级 22,依赖 clip_embed 完成的代表帧与 sidecar)
- UI:筛片页信息面板「八维标签」区(维度名+标签+置信度);过滤条按维度筛(下拉);搜索与维度筛可叠加
- 可解释硬约束照旧:分数入库,UI 可见

## 验收
cargo ≥8(原型分类落库/不确定阈值/时段规则边界/声音规则/幂等);sidecar 自测扩 classify;五门全绿;真机:97 条素材上主体/景别的 top-1 目测抽查 10 条(主审)。

## 纪律
纯写不碰 git 不跑构建;迁移只加 0012;禁碰 player/deliver 核心。
