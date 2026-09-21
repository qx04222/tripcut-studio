# R21 W2 照片合成回归夹具

`manifest.json` 为真值。生成器在 `tests.rs::r21_generate_photo_fixtures`，使用仓库已有的 image 0.25.10。全部 512×384 PNG，无外部图片和业主素材。

- `IMG_*.png`：10 个不同的确定性块状场景，每组 3 张，平移 0–2 px、亮度加 0–6。同组时间间隔 5 s、文件号差 10，刻意让连拍硬规则不能代替 dHash 检测。
- `quality-00..04`：Gaussian σ=8；`05..09`：各通道除以 8（合成 -3 EV）；`10..19`：未退化图片。
- `night.png`：暗背景 + 有面积的高光，保护夜景。
- 跨事件测试复制第一张到测试临时目录，拍摄时间设为两小时后；不修改真实原片。

这些是算法回归样本，不是相机实拍精度证明。当前 Rust 测试未运行：指定共享 target 被沙箱拒绝写锁文件。不得把 fixture 数量当作 PH-06/07/09 的通过数字。

验证环境解除阻塞后，先在仅含测试的源码基线上跑 `cargo test r21_ph -- --nocapture`，保留真实红灯，再实现后重跑。取消延迟、带 CLIP 消融、混排预算、primary 与持久化边界仍需补测试。

重生成：`cargo test r21_generate_photo_fixtures -- --ignored --nocapture`。
