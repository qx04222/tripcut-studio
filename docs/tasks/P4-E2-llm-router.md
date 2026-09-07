# 任务卡 P4-E2:订阅大模型 CLI 路由层(可关闭增强)

状态:排队(E1 后派发)。实施:Codex。主审:Claude。

## 依据
规格 §5-L3(OpenClaw 实证设计):显式 provider 锁定失败即报错不静默降级;未锁定走 fallback 链;预算账本+熔断;核心闭环零依赖本层;整层可关。

## 范围
- `core/llm.rs`:provider 枚举 Claude(claude -p)/Codex(codex exec)/Kimi(kimi -p);调用=短命子进程,prompt 模板内嵌 JSON Schema,输出 serde 严格解析(失败=失败,不猜);超时 120s;二进制探测(PATH,缺失→该 provider 不可用)
- 预算:settings 表存 `llm_enabled`(默认 false)/`llm_provider`(auto 或锁定)/`llm_monthly_budget`(默认 200 次);`llm_ledger` 表(migration 0011:调用时间/provider/用途/预估tokens/结果状态);超预算熔断,UI 明示
- 功能(仅两个,最小切口):
  a) 「AI 描述」:选中素材→取封面帧路径+L1/运镜结构化数值→让模型输出一句中文描述(≤40字)+3个中文标签,写 tags(source='ai_l3');批量按钮带预估确认
  b) 「导演问答」:设置页开关开启后,筛片页问答框;上下文=当前筛选统计+精选清单摘要(纯文本,无帧);答案仅展示,不写库
- 隐私:发送内容明细写进设置页说明(帧路径→实际是把帧文件读给 CLI?**不**:claude -p 支持图片输入吗——用文本模式:只发结构化数值与文件名,不发图像,避免上传素材;卡内定死)
- 设置页接入:开关/provider/预算/账本查看(最近20条)
## 非目标
故事建议;流式输出;自动重试跨 provider(锁定时);Seedance。

## 验收
cargo ≥8(schema 解析/熔断/锁定不降级/fallback 链/账本/开关关闭时全路径不可达);五门全绿;真机:开着 claude CLI 实测「AI 描述」一条(主审执行,消耗真实额度,单条验证即可)。

## 纪律
纯写不碰 git 不跑构建;迁移只加 0011;禁碰 player/deliver 核心;默认关闭是硬约束。
