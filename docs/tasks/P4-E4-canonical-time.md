# 任务卡 P4-E4:多设备时间轴——Proxy 映射保证 + Canonical Journey Time

状态:排队(E3 后)。实施:Codex。主审:Claude。依据:附录 E.2。

## 范围
- **导入元数据扩展**(migration 0016 加列):audio_sample_rate/rotation/color_transfer/hdr_flag/tz_guess/device_model(ffprobe+现有链路,不重扫已导入——增量 backfill job)
- **Proxy↔Source 映射**:代理生成时落 `proxy_time_map(clip_id, proxy_ts_ms, source_ticks)` 采样表(每秒1点+首尾);播放器走代理时的打点经映射回源 ticks;属性测试:往返误差 ≤1 tick
- **Canonical Journey Time**:`clips.journey_offset_ms`(设备钟偏移修正);推断 job `align_clocks`:按 device_model 分组,组间用 GPS 轨迹重叠+拍摄间隔模式估计偏移;置信度低→UI「设备时钟校正」面板人工设偏移(每设备一个值);章节/故事板排序改用 captured_at+offset
- 时区错检测:GPS 经度推时区 vs 文件时区标记冲突→提示
## 验收
cargo ≥8(映射往返/偏移应用后排序/低置信不自动改);真机:F 组夹具(钟错/时区错)校正后时间轴连续。
## 纪律
纯写不碰 git 不跑构建;迁移只加 0016;偏移永不改写 captured_at 原值。
