# 任务卡 P2-C1:任务 runner 并行 worker 池

状态:派发(2026-08-31,主树)。实施:Codex。主审:Claude。

## 目标与依据
规格 §9 实测对账:单 runner 500 条约 100 分钟,4 并发即进 10 分钟级。把 T1 的单 runner 改成可配 worker 池,默认 4,保持全部既有语义。

## 范围
- `jobs` 运行层:N 个 tokio 任务并行 claim/run;`claim_next` 的事务领取已防双领(验证并补测试:两 worker 并发 claim 同一 job 只有一个成功)
- 每 clip 的任务天然无交叉写(不同 artifact 不同文件;analyze/thumbnail 均写各自表),但 **SQLite 连接不可跨线程共享**:每 worker 独立 Connection;WAL 下写写冲突用 busy_timeout(5s)+重试
- export_package 保持独占:worker 池领到 export 时,其余 worker 暂停领新任务直到其完成(简单实现:全局信号量/独占标志),避免导出和重编码互抢 CPU
- 并发度配置常量 WORKER_COUNT=4(注释注明 M5 实测依据),`get_app_info` 暴露
- 失败注入测试:并发下 kill 恢复语义不变(running→pending 不重复不遗漏)

## 非目标
不改优先级表;不做每任务类型的独立并发上限(P3 再说)。

## 验收
cargo 新增 ≥5 测试(双领互斥/并发完成计数/独占导出/busy 重试/恢复);全套既有测试在并发 runner 下 3 连绿(注意别引入新的测试隔离问题);五门全绿。真机:重导 89 条素材缓存(删缓存重建)墙钟 < 单 runner 的 1/2.5。

## 纪律
纯写文件不碰 git 不跑构建;禁改 docs/spikes/README;禁改已应用迁移。
