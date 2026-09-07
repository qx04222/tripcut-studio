# 任务卡 P1-T6:稳定交付包(MVP 收官卡)

状态:派发(2026-08-31,worktree 车道)。实施:Codex。主审/验收:Claude。

## 1. 依赖与前置
基于 main(T1-T4)。前置:规格 §8(稳定包是一等公民;帧精确协议;VFR/HEVC 规则);E0(原生草稿属 P4,本卡**只做②层稳定包**)。**并行车道 T5 在做筛片视图,不得触碰 ratings 写路径与筛片(Select)视图文件;本卡读 ratings 即可。**

## 2. 用户可观察目标
「交付」视图:显示当前精选统计(收藏 N 条/总时长);点「生成交付包」选目标目录后,产出:
```
<项目名>_剪映交付_<日期>/
├── 01_精选片段/          # 每条收藏素材单独文件
├── 02_参考粗剪.mp4       # 按拍摄时间顺序拼接
├── 03_镜头表.csv         # UTF-8 BOM,剪映/Excel 可开
└── 交付说明.txt          # 怎么用这个包(中文一屏)
```
过程有进度条与逐条状态;失败单条标红不中断整包;完成后「在访达中显示」按钮。

## 3. 范围
- 后端 job 种类 `export_package`(单 job,内部逐条推进并写子进度到 payload/结果):
  - 精选=有 binary=1 最新评级的 clips(按 captured_at 排序)
  - 片段导出:整条复制优先(`-c copy` remux 到 mp4 容器;HEVC 源保持 hvc1 tag);**入出点裁切本卡不做**(评级是整条级,P2 接入出点后升级),故无关键帧问题;VFR 源:` -fps_mode passthrough` remux,记录 is_vfr 到镜头表
  - 参考粗剪:concat(不同编码/分辨率混合时统一转码 1080p H.264 videotoolbox+aac;全同参数时可 concat demuxer 快路径,实现自选一种并写明,**转码路径必须做**)
  - 镜头表 CSV:文件名/原路径/时长/分辨率/编码/fps/VFR/拍摄时间/星级/L1角标摘要/顺序号
  - 目录名冲突自动加序号;磁盘空间预检(预估=精选总字节×1.2,不足即拒绝并明示)
  - 全程走 T1 原子产物协议;取消:本卡实现"进程内取消标志"即可(UI 取消按钮→job 标 failed+清理半成品)
- 后端 `get_export_status`/`start_export(dest)`;前端 DeliverPage:统计卡、目录选择(rfd)、进度列表、完成态
**不做**:SRT(P2 whisper 后)、原生草稿(P4)、帧精确切片(P2)、smart-cut。

## 4. 杀停条件
concat 转码若 videotoolbox 不可用降 libx264(同 T3 规则)。

## 5-9
CSV 用 UTF-8 with BOM;失败单条记 stderr 摘要进镜头表备注列。cargo 新增 ≥8 测试(精选集查询/排序/remux 成功/损坏源单条失败不中断/磁盘预检拒绝/目录冲突加号/CSV 转义(文件名含逗号引号)/原子性);前端 vitest ≥2;真机:对 89 条素材评几条收藏后整包生成成功且粗剪可播。

## 10-16
纯写文件不碰 git 不跑构建;worktree 路径 <local-worktree>;禁改 docs/spikes/README 与 Select/ratings 写路径;主审门禁+真机;变更记录 v1。
