# 任务卡 P2-C7:全屏化布局/字号体系/完整设置页(业主直接反馈)

状态:派发(worktree <local-worktree>)。实施:Codex。主审:Claude。
业主原话:「整体的框架大一些,现在感觉不是全屏设计的。字号也有点小。还有设置功能尽可能齐全。」

## 范围

### 1. 窗口与全屏化布局
- tauri.conf.json:默认窗口 1512×945,minWidth 1200/minHeight 760,居中;`resizable/maximizable` 确认开启;记忆上次窗口尺寸与位置(自存 settings 表,启动恢复;不引第三方插件)
- 排查全部页面的硬性宽度上限(max-width/固定列宽),主内容区必须随窗口伸展:筛片墙列数自适应(minmax 网格);导入列表/交付页同理;侧边栏保持固定宽但主区吃满
- 大屏(≥1800 逻辑宽)下不出现两侧大片空白

### 2. 字号体系
- styles.css 顶部建 token:`--font-xs:11px; --font-sm:12.5px; --font-base:14px; --font-lg:16px; --font-xl:19px; --font-display: clamp(...)`;全站替换硬编码字号——**现存 8-10px 的辅助标签全部提级到 xs/sm**,正文 base,标题用 lg/xl/display
- html root `font-size` 乘以界面缩放设置(0.9/1.0/1.15/1.3 四档,默认 1.0),全站字号 token 改用 rem 使缩放全局生效

### 3. 完整设置页(新导航项「04 设置 SETTINGS」)
- **存储**:migration **0008**:`settings(key TEXT PK, value TEXT, updated_at)`;commands `get_settings()/set_setting(key,value)`;各处读取带默认值(常量退级为默认)
- **外观**:主题三档(跟随系统/浅色/深色→html data-theme,规格 §7 早已预留);界面缩放四档
- **性能**:worker 并发 1-8(默认4,标注"重启生效");代理生成开关
- **工具链**:ffmpeg/ffprobe 路径检测卡片(存在性+`-version` 首行);whisper 二进制与模型档位(large-v3-turbo/small)选择+模型文件存在性检测(models 目录)+缺失时的下载指引文案;CLIP sidecar 状态(venv 存在性+「运行自检」按钮调 ping)
- **分析阈值**:场景切分 T、相似度阈值、抖动阈值——滑杆+当前值+「恢复默认」;job 执行时从 settings 读(带默认)
- **缓存**:占用统计(cache_artifacts SUM(bytes)+目录 du 实测)+「清空缓存并重建」按钮(删缓存目录、重置 thumbnail/waveform/proxy/clip_embed jobs 为 pending,决策数据不动——规格三层存储)
- **关于**:应用版本/schema 版本/依赖许可清单(静态文本列表)
- 全中文、token 配色、深浅色自适应、IME 安全

## 非目标
自动更新;快捷键自定义(P5);语言切换。

## 验收
cargo ≥6(settings 读写默认/迁移/缓存统计/重建重置 jobs 范围正确——不得动 ratings/clips);前端 ≥4(缩放档写读/主题切换/阈值滑杆);五门全绿。真机(主审):1512 默认窗与全屏下布局吃满、字号观感、设置各卡片功能逐项点验、清缓存后缩略图能重建。

## 纪律
纯写不碰 git 不跑构建;迁移只加 0008(注意 C4=0006、C6=0007 在并行车道,数组留显式缺口注释,合并接线人统一);禁改 docs/spikes/README;player/deliver/sidecar 内部逻辑不动(只读状态)。
