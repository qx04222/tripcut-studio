# 任务卡 P3-D3:叙事结构 v2(Episode/Chapter/Beat + Destination Card)

状态:排队(C8 之后派发)。实施:Codex。主审:Claude。
依据:规格附录 C(业主定义)。依赖:C8 八维标签、C3 transcript_segments、E2 llm.rs 路由、D2 章节(降级为信号层)。

## 范围
- migration 0013:`episodes(id,title,theme,created_at)` / `narrative_chapters(id,episode_id,kind/*10类叙事单元*/,title,order,promoted INTEGER)` / `narrative_beats(id,chapter_id,clip_id,segment_id,role/*beat|montage|transition*/,order)` / `destination_cards(id,chapter_id,name,geo_context,highlights,why_visit,personal_note,sources_json,verified INTEGER DEFAULT 0)`
- **信号层**:D2 的时间/GPS 断档 + 八维⑦时段 + 转写话题切换(相邻转写段无重叠关键词)→ 产出候选边界列表(纯本地,不定章)
- **叙事编排 job `narrate_episode`**(需 L3 开启;关闭时故事板退回 D2 行为并明示):输入=候选边界+每镜头结构化摘要(八维标签/时长/转写摘录/GPS地名逆查(本地 reverse-geocode 用离线粗粒度即可,无则经纬度原样)+章节信号;prompt 要求输出 JSON:章节列表(kind/title/成员镜头/promoted 理由)+重复性房车内容降级清单+Destination Card 草稿;serde 严格解析;**分数与依据入库,UI 可见"为什么这么分"**
- Destination Card:LLM 产出的地理/历史内容一律 `verified=0` +「待核实」徽章;sources_json 记模型自述依据;UI 卡片可编辑可标记已核实;**绝不把未核实信息写进交付说明**
- 故事板 UI 升级:三级树(Episode>Chapter>Beat);章节 kind 徽章(10类中文);降级内容折叠为 Montage 组;Destination Card 侧栏;一键"重新编排"(带预算确认,走 E2 账本)
- 交付:粗剪/草稿按 Beat 顺序;镜头表加 Chapter/Beat 两列;Destination Card 导出为 `05_地点卡/<名称>.md`(标注核实状态)
## 非目标
自动写旁白稿;外部网络检索(模型知识+待核实标记即可,联网增强留后);多集管理 UI(episodes 表先单集)。

## 验收
cargo ≥8(信号层边界/LLM JSON 解析与拒绝/降级规则落库/L3 关闭回退/卡片核实态流转);前端 ≥3;五门全绿;真机:97 条素材开 L3 编排一次(主审执行,真额度单次),目测章节合理性与降级清单。

## 纪律
纯写不碰 git 不跑构建;迁移只加 0013;L3 默认关是硬约束;禁碰 player/deliver 核心切片逻辑。
