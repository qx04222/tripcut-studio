# 任务卡 P5-F2:doctor 自检/崩溃恢复/数据保护

状态:排队(F1 后)。实施:Codex。主审:Claude。

## 依据
规格 §3/§4/§11 + OpenClaw doctor 模式(拒绝带病运行)。

## 范围
- `core/doctor.rs`:启动自检清单(db 可开与版本/缓存目录可写/磁盘余量>2GB/工具链探测/上次异常退出标记),三态 OK/WARN/FAIL;FAIL(db 损坏/版本超前)→专用恢复界面而非白屏:提供「从快照恢复」「导出决策数据」「重建缓存」三按钮
- db 快照:每次成功启动+每小时 VACUUM INTO `snapshots/project-<ts>.db`(保留最近5份);恢复=快照回填
- 异常退出标记:启动写 sentinel,正常退出清;检测到残留→doctor 页提示并自动跑 running→pending 恢复(已有)+缓存一致性抽查
- 崩溃兜底:Rust panic hook 落日志(脱敏:路径仅文件名)到 `logs/`,保留7天;设置页「打开日志目录」
- 交付/导入进行中强退的恢复测试补全(失败注入)
## 验收
cargo ≥8(doctor 各态/快照轮转/恢复回填/sentinel);真机:kill -9 后重启走完整恢复路径;五门全绿。

## 纪律
纯写不碰 git 不跑构建;迁移不加(快照是文件级)。
