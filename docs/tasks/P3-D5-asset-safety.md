# 任务卡 P3-D5:Asset Safety 加固——Rescue Candidate 与叙事覆盖

状态:排队(D4 后)。实施:Codex。主审:Claude。依据:附录 E.1。

## 范围
- **删除路径审计**(实施第一步):grep 全仓所有对原片的 remove/delete 调用,产出审计清单进报告——预期为零,发现即修
- migration 0015:`clips.safety_flag TEXT CHECK(IN('normal','likely_unusable','rescue_candidate'))` + `rescue_ranges(clip_id,in_ticks,out_ticks,reason)`
- 判定规则:技术四维(Image/Motion/Audio 来自 L1/C6)全低+叙事信号高(八维⑥真实反应/转写情绪词/独特事件标签)→rescue_candidate;技术全低+叙事无信号→likely_unusable(只影响排序,UI 灰组可展开)
- 可用子区间:对 rescue_candidate 按 L1 逐秒采样分数找最优连续窗(抖动分最低的 ≥2s 窗),写 rescue_ranges,筛片信息面板显示"建议使用 07.2-09.8s"+一键设为精选段(接 D1 select segment)
- 抢救建议清单:按缺陷类型映射(抖→稳定/裁切;噪→降噪;风噪→VO覆盖建议)——纯文案建议,不执行处理
- Best Take 六轴接线:Narrative 轴含 unique_event 加权,rescue_candidate 不因技术分被 Stack 淘汰(独立显示)
## 验收
cargo ≥8(审计脚本零删除断言/判定边界/最优窗算法/likely_unusable 不影响保留);真机:G 组夹具(坏素材但重要)每条都不被压制。
## 纪律
纯写不碰 git 不跑构建;迁移只加 0015。
