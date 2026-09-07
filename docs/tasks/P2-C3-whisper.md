# 任务卡 P2-C3:whisper 转写/对白搜索/SRT 交付

状态:草拟(C1 合入后派发,worktree)。实施:Codex。主审:Claude。

## 目标与依据
规格 §5-L2;S5 实测:brew 的 `whisper-cli` 二进制,large-v3-turbo 24x 实时,`-osrt` 时间戳标准。为有音轨素材生成中文转写,支持对白关键词搜索,交付包附 SRT。

## 范围
- 新 job `transcribe`(优先级 15,低于 clip_embed):仅 has_audio=1 且非静音(L1 判据)素材;调 `whisper-cli`(WHISPER_BIN/PATH 寻址,模型路径 WHISPER_MODEL 环境变量或 `~/Library/Application Support/TripCutStudio/models/` 下探测,缺则 job blocked 并给下载指引文案:`huggingface ggml-large-v3-turbo.bin`);语言 zh 自动检测,输出 json+srt 到缓存层(cache_artifacts kind 扩展需 migration 0005:CHECK 加 'transcript','srt' 两枚举——**新建迁移,禁改旧迁移**)
- migration 0005 另建 `transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text)` 供检索
- 对白搜索:`search_transcripts(keyword) -> [(clip_id, seg, text, ticks)]`(SQL LIKE 即可,FTS5 加分不强求);筛片页搜索框结果区分「画面匹配/对白匹配」两组(C2 未合入时对白组独立可用,接口设计好留位)
- 交付包(deliver):精选素材若有转写,`03_字幕/` 目录放每条 `<序号>_<名>.srt`,镜头表加「对白摘要」列(前 30 字);无转写不阻塞
- 设置常量:模型档位默认 large-v3-turbo,低配档 small(常量+注释,S5 数据)
## 非目标
烧字幕;翻译;说话人分离;实时。

## 验收
cargo ≥6 测试(转写解析入库/ticks 换算(srt 时间→源 time_base)/静音跳过/模型缺失 blocked 文案/SRT 落包/CSV 新列);夹具用 say 合成中文短音频(S5 手法,缺 say/whisper 则 skip);五门全绿;真机:对含语音的 raw 素材(S4 的 walking tour 有英文解说,zh 自动检测会出英文——可接受,断言"有转写文本"而非语种)搜索命中。

## 纪律
纯写不碰 git 不跑构建;禁改 docs/spikes/README、player、jobs 优先级表以外的 jobs 逻辑;迁移只加 0005。
