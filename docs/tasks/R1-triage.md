# 发布前修复分诊(Codex 复审 2026-09-01,NO-GO → 修复轮)

主审裁决:
- 车道A(main) R1核心:🔴1 多实例恢复竞态(project.db 文件锁,§4 既定设计补实现)/🔴2 清缓存暂停runner(独占信号量复用导出机制)/🔴4 导出浮点秒入库+PTS回读不校源边界(改tick入库+边界校验)/🔴5 外置盘重绑需完整哈希确认/🟡8 导出完成标记/🟡12 import·export 重试blocked一致+取消覆盖
- 车道B R2设置接线:🟡10 工具路径设置接到全部任务/🟡11 抖动阈值真生效/🟡13 loopback 改Authorization+锁origin(代理URL用短时签名)/🟡16 吞错分级(损坏payload→blocked可见,设置读损→区分未设置)
- 车道C R3前端:🟡14 IME两漏点(PlayerOverlay Esc顺序/Storyboard composition生命周期)/🟡15 中文状态映射(账本/播放器状态)
- 车道D F4:E.3 Benchmark门禁(🔴7,原卡照做)
- 随后:D5(🔴6 Narrative Override)、E4(🔴3 真实PTS链+钟漂)
- 🟡9 L3进程隔离:测试版保持默认关(Codex备选案),正式版列RELEASE.md
