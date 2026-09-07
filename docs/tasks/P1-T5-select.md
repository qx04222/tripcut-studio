# 任务卡 P1-T5:筛片工作台(评级/快捷键/胶片墙)

状态:派发(2026-08-31,主树车道)。实施:Codex。主审/验收:Claude。

## 1. 依赖与前置
基于 main(T1-T4 已合入)。前置:规格 §7;ratings 表(追加式,segment 级)已在 schema v1;T4 提供 analysis 角标;T3 提供 cover/strip/waveform。**并行车道 T6 在做交付导出,不得触碰 exports 相关文件与"交付"视图。**

## 2. 用户可观察目标
「筛片」视图:胶片网格(封面卡片墙,非表格)展示全部可用素材;鼠标横移卡片即在封面/胶片条帧间滑动预览(skimming,用已有 strip.jpg 的 N 帧);键盘 F 收藏/X 拒绝/1-5 星/0 清除,当前选中卡片高亮;顶部过滤条(全部/收藏/未评/拒绝 + 角标过滤:排除疑似废片);中文输入法激活时快捷键灰显并显示提示条。评级即时落库,重开应用不丢。

## 3. 范围
- 后端:`rate_clip(clip_id, rating_type, value)`(写 ratings,追加式;segment 维度本卡简化为"整条素材的代表 segment"——取该 clip 第一个 scene segment,无 segment 则建 kind='whole' 的整条 segment);`list_clips` 扩展最新评级字段(每 clip 取最新一条 binary 与最新 star)
- 前端 SelectPage:虚拟化网格(CSS grid+窗口化,89-500 卡流畅);卡片=封面+文件名+时长+角标+评级标记;skimming=onMouseMove 按 x 比例切换 strip 帧(background-position 或 canvas 裁绘,不加载新资源);键盘处理挂在网格容器(tabIndex),**IME 防护:compositionstart/end 与 e.isComposing 时忽略,且检测 navigator/键盘布局不可行时以事件为准;激活时顶部提示条**(规格 §7)
- 过滤:内存过滤已加载列表即可(数据量 P1 规模),角标过滤复用 T4 枚举
**不做**:JKL 播放器(libmpv 集成是独立卡)、Audition 容器、Source Tape、搜索、拖拽排序、交付相关。

## 4. 杀停条件
无外部依赖;若 strip.jpg 帧数拼版格式不便按帧裁切,读 cache_artifacts 里的元信息或按固定 12 帧约定,写明假设。

## 5-8(契约/不变量/状态机/夹具)
ratings 只插不改(触发器已保证);rating_type ∈ binary(1收藏/-1拒绝)/star(1-5);夹具沿用测试内生成;前端组件测试:评级按键、IME 组合态忽略、过滤计数。

## 9. 量化验收
cargo 新增 ≥6 测试(rate_clip 落库/最新评级取值/whole segment 兜底/追加不覆盖);前端 vitest ≥3;五门全绿;主审真机:89 条卡墙滚动流畅、skimming 可用、F/X/星即点即显、重启不丢。

## 10-16
纯写文件不碰 git 不跑构建;禁改 docs/spikes/README 与交付(export/Deliver)相关文件;主审跑门禁与真机;变更记录 v1。
