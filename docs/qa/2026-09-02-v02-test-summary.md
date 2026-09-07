# v0.2 系列测试汇总(截至 2026-09-02 下午,v0.2.4)

## 一、版本演进与修复账
| 版本 | 触发 | 修复 |
|---|---|---|
| v0.2.0 | 夜间硬门冲刺 | Benchmark 18/18 全绿首达;checkpoints 断链/4K 采样超时/采样失败拒导入(Asset Safety)三层根因;9 个夹具数据缺陷重生成 |
| v0.2.1 | 业主报"装了还提示未装" | Finder 最小 PATH 找不到 Homebrew 工具(settings 解析器) |
| v0.2.2 | 业主报"恢复页进不去" | 四 P0:doctor 第二份 PATH 解析/恢复页禁滚不可达/release 误用 dev 库/正常退出不清哨兵(run() 后死代码) |
| v0.2.3 | 业主报"改预算闪退" | 三 P0:五处 setState 闭包读失效事件致白屏(+根级 ErrorBoundary)/L3 第三份 PATH 解析+用户级目录/播放器主线程环形死锁(打包版播放器首次可用) |
| v0.2.4 | 业主报"Stack 收不起+堆积" | quality_exempt 强制展开+浮层互相覆盖;统一切换交互+▸/▾ 指示 |

## 二、真机覆盖面(打包版 DMG 实装,cliclick+AX+截图)
- 启动链:干净首启直进/异常标记→恢复页→进入→退出清标记→重启直进 ✅
- 双实例:第二实例弹明确只读提示 ✅
- 导入:NSOpenPanel 真选目录、10 条入库、任务管线 99 done 零 blocked ✅
- 筛片逐控件:卡片选中、评级(1-5)、F 收藏、Stack 展开/收起双向、成员锁定/排除/Promote Hero、过滤 tab×3、八维下拉(8 项)、排除废片开关、只看 Stack 首选开关 ✅
- 故事板:D2 章节、Routine 徽章、L3 关闭降级文案 ✅
- 交付:交付包全产物(精选/粗剪 51s=预估/CSV BOM/SRT/说明)+ffprobe 双验证 ✅
- 播放器:libmpv 画面渲染、播放推进、Esc 退出 ✅(死锁修复后)
- 设置:六分区、预算/阈值/权重输入、L3 三 CLI 全绿、工具链检测、关于页 ✅
- 主题:深色四页(导入/筛片/交付/设置)无白块、130% 缩放生效 ✅(遗留项关闭)

## 三、自动化底座
- 硬门 Benchmark:runner exit 0 + metrics PASS 18/18(Critical Recall=1.0、vfr 6/6、proxy 69/69 误差 0µs、压制率 0、原片树零变化)
- 六门:tsc/vitest 71/cargo test/clippy -D warnings/tauri build/DMG 冒烟
- 806 行测试矩阵(docs/qa/2026-09-02-v01-test-matrix.md)

## 四、已知遗留(不阻塞)
1. 播放中时间码疑似不刷新(画面推进正常)——待业主人工确认
2. 语义门(scene/important_event)informational,待真实素材标注恢复硬门
3. L3 真机实调(耗真实额度)留业主执行
4. 导入/交付/设置页未做筛片级逐控件轮(已做主链路+深色)
