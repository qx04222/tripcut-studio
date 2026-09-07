# 任务卡 P2-C2:中文语义搜索(Chinese-CLIP + sqlite-vec)

状态:草拟(C1 合入后派发,主树)。实施:Codex。主审:Claude。

## 目标与依据
规格 §5-L2;S3 拍板 **PyTorch-MPS**(ONNX CoreML 崩,勿走);参考 spikes/s3-chinese-clip/bench_pytorch.py 的加载与编码写法、MaterialSearch 思路。用户在筛片页输入中文自然语言("海边 日落 无人机"或整句),按语义相关度排序素材。

## 范围
- **Python sidecar**(常驻进程,规格 §3):`sidecar/clip_service.py`——stdin/stdout JSON-RPC(每行一个请求/响应);方法:`embed_images(paths[]) -> [[f32;512]]`、`embed_text(query) -> [f32;512]`、`ping`。模型 OFA-Sys/chinese-clip-vit-base-patch16,device=mps,懒加载;venv 引导脚本 `sidecar/setup.sh`(python3 -m venv + pip 装 torch/transformers 钉版本,写进脚本);Rust 侧 `core/sidecar.rs`:启动/心跳/超时 kill 重启/未安装时明确报错(设置页文案"运行 sidecar/setup.sh")
- 新 job `clip_embed`(优先级 25,低于 analyze_l1):每 clip 取 strip.jpg 的帧(已有拼版,裁出各帧临时文件或直接传 strip+帧数让 sidecar 裁)编码,均值向量入 sqlite-vec
- migration 0004:sqlite-vec 虚拟表 `clip_embeddings`(rusqlite 加载 sqlite-vec 扩展,crate `sqlite-vec` 或 bundled 编译;不可行则降级 BLOB 存向量+Rust 余弦暴力扫,89-500 条规模完全够用——**降级路径必须实现为缺省可用**,vec 扩展作为优化)
- 搜索:`search_clips(query) -> [(clip_id, score)]`;筛片页顶部搜索框(中文输入完整支持,回车触发,IME 组合态不触发),结果按分数排序显示并展示"匹配度 xx%";空查询恢复默认排序
- **可解释硬约束**:排序只吃余弦分数(结构化数值),UI 显示分数
## 非目标
对白搜索(C3);相似容器(C4);跨项目;VLM。

## 验收
cargo ≥6 测试(sidecar 协议 mock/嵌入落库/降级余弦排序正确性/幂等);Python 侧最小自测脚本;五门全绿(Python 不进门禁,但 setup.sh 在干净 venv 可跑通由主审验证);真机:搜"街道 汽车"命中曼谷/西安街景排前,搜"海滩 无人机"命中 tybee 排前(89 条真素材,主审目测)。

## 纪律
纯写不碰 git 不跑构建;禁改 docs/spikes/README、player、deliver;迁移只加 0004。
